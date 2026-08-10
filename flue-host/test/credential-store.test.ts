import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  FileCredentialStore,
  acquireStoreLock,
  storeBackedProviders,
  withStoreAuth,
} from "../src/engine/credential-store.js";
import { describe as describeCause } from "../src/engine/flue.js";

async function tempStore(): Promise<{ dir: string; path: string; store: FileCredentialStore }> {
  const dir = await mkdtemp(join(tmpdir(), "buzz-credstore-"));
  const path = join(dir, "credentials.json");
  return { dir, path, store: new FileCredentialStore(path) };
}

/** Write a store document the way the Rust sink does (schema fixture). */
async function seedRustShapedStore(path: string): Promise<void> {
  const doc = {
    version: 1,
    providers: {
      xai: {
        credential: { type: "api_key", key: "xai-test-key" },
        deliveredCreatedAt: 1_754_800_000,
        updatedAt: 1_754_800_000,
      },
      anthropic: {
        credential: {
          type: "oauth",
          access: "at-1",
          refresh: "rt-1",
          expires: Date.now() + 3_600_000,
          subscriptionType: "max",
        },
        deliveredCreatedAt: 1_754_800_001,
        updatedAt: 1_754_800_001,
      },
    },
  };
  await writeFile(path, JSON.stringify(doc, null, 2));
}

describe("FileCredentialStore", () => {
  it("reads entries from a Rust-sink-shaped document", async () => {
    const { path, store } = await tempStore();
    await seedRustShapedStore(path);

    const xai = await store.read("xai");
    expect(xai).toEqual({ type: "api_key", key: "xai-test-key" });
    const anthropic = await store.read("anthropic");
    expect(anthropic?.type).toBe("oauth");
    expect(await store.read("absent")).toBeUndefined();

    const listed = await store.list();
    expect(listed.map((i) => i.providerId).sort()).toEqual(["anthropic", "xai"]);
  });

  it("treats a missing file as empty, and a corrupt file as an error", async () => {
    const { path, store } = await tempStore();
    expect(await store.read("xai")).toBeUndefined();
    expect(await store.list()).toEqual([]);

    await writeFile(path, "{not json");
    await expect(store.read("xai")).rejects.toThrow();
  });

  it("picks up external rewrites (mtime/size cache invalidation)", async () => {
    const { path, store } = await tempStore();
    await seedRustShapedStore(path);
    expect((await store.read("xai") as { key?: string }).key).toBe("xai-test-key");

    // Simulate the Rust sink applying a rotation: rewrite the file directly
    // with a bumped mtime.
    const doc = JSON.parse(await readFile(path, "utf8"));
    doc.providers.xai.credential.key = "xai-rotated";
    await writeFile(path, JSON.stringify(doc));
    const past = new Date(Date.now() + 5);
    const { utimes } = await import("node:fs/promises");
    await utimes(path, past, past);

    expect((await store.read("xai") as { key?: string }).key).toBe("xai-rotated");
  });

  it("modify persists, preserves sink metadata, and delete removes", async () => {
    const { path, store } = await tempStore();
    await seedRustShapedStore(path);

    await store.modify("anthropic", async (current) => {
      expect(current?.type).toBe("oauth");
      return { ...(current as OAuthCredential), access: "at-2", refresh: "rt-2" };
    });

    const doc = JSON.parse(await readFile(path, "utf8"));
    expect(doc.providers.anthropic.credential.access).toBe("at-2");
    // The delivery watermark written by the Rust sink must survive our write.
    expect(doc.providers.anthropic.deliveredCreatedAt).toBe(1_754_800_001);
    // Store writes are private.
    if (process.platform !== "win32") {
      const info = await stat(path);
      expect(info.mode & 0o777).toBe(0o600);
    }

    await store.delete("anthropic");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.providers.anthropic).toBeUndefined();
    expect(after.providers.xai).toBeDefined();
  });

  it("serializes concurrent modifies per provider", async () => {
    const { store } = await tempStore();
    const order: string[] = [];
    await Promise.all([
      store.modify("xai", async () => {
        order.push("first");
        return { type: "api_key", key: "a" };
      }),
      store.modify("xai", async (current) => {
        order.push("second");
        expect((current as { key?: string })?.key).toBe("a");
        return { type: "api_key", key: "b" };
      }),
    ]);
    expect(order).toEqual(["first", "second"]);
    expect((await store.read("xai") as { key?: string }).key).toBe("b");
  });
});

describe("acquireStoreLock", () => {
  it("blocks a second acquirer until release, then times out cleanly", async () => {
    const { path } = await tempStore();
    const release = await acquireStoreLock(path, { lockTimeoutMs: 500 });
    await expect(
      acquireStoreLock(path, { lockTimeoutMs: 120, lockRetryMs: 10 }),
    ).rejects.toThrow(/timed out/);
    await release();
    const second = await acquireStoreLock(path, { lockTimeoutMs: 500 });
    await second();
  });

  it("takes over a stale lock", async () => {
    const { path } = await tempStore();
    await writeFile(`${path}.lock`, "999999");
    // staleMs 0 => any existing lock is immediately stale.
    const release = await acquireStoreLock(path, { lockStaleMs: 0, lockTimeoutMs: 500 });
    await release();
  });
});

function fauxProvider(overrides: Partial<Provider> & { refreshed?: OAuthCredential[] } = {}): Provider {
  const refreshed = overrides.refreshed ?? [];
  return {
    id: "faux",
    name: "Faux",
    auth: {
      apiKey: {
        name: "Faux API key",
        resolve: async () => ({ auth: { apiKey: "from-env" }, source: "FAUX_API_KEY" }),
      },
      oauth: {
        name: "Faux OAuth",
        login: async () => {
          throw new Error("not used");
        },
        refresh: async (credential: OAuthCredential) => {
          const next = {
            ...credential,
            access: `${credential.access}+refreshed`,
            refresh: `${credential.refresh}+rotated`,
            expires: Date.now() + 3_600_000,
          };
          refreshed.push(next);
          return next;
        },
        toAuth: async (credential: OAuthCredential) => ({
          headers: { Authorization: `Bearer ${credential.access}` },
        }),
      },
    },
    getModels: () => [],
    stream: (() => {
      throw new Error("not used");
    }) as never,
    streamSimple: (() => {
      throw new Error("not used");
    }) as never,
    ...overrides,
  } as Provider;
}

describe("withStoreAuth", () => {
  it("stored api_key wins over env", async () => {
    const { store } = await tempStore();
    await store.modify("faux", async () => ({ type: "api_key", key: "from-store" }));
    const wrapped = withStoreAuth(fauxProvider(), store);
    const result = await wrapped.auth.apiKey?.resolve({ ctx: {} as never });
    expect(result?.auth).toEqual({ apiKey: "from-store" });
    expect(result?.source).toBe("buzz credential store");
  });

  it("falls back to the provider's own resolution when nothing is stored", async () => {
    const { store } = await tempStore();
    const wrapped = withStoreAuth(fauxProvider(), store);
    const result = await wrapped.auth.apiKey?.resolve({ ctx: {} as never });
    expect(result?.auth).toEqual({ apiKey: "from-env" });
    expect(result?.source).toBe("FAUX_API_KEY");
  });

  it("uses a fresh stored oauth credential without refreshing", async () => {
    const { store } = await tempStore();
    const refreshed: OAuthCredential[] = [];
    await store.modify("faux", async () => ({
      type: "oauth",
      access: "at-fresh",
      refresh: "rt",
      expires: Date.now() + 3_600_000,
    }));
    const wrapped = withStoreAuth(fauxProvider({ refreshed }), store);
    const result = await wrapped.auth.apiKey?.resolve({ ctx: {} as never });
    expect(result?.auth.headers?.["Authorization"]).toBe("Bearer at-fresh");
    expect(refreshed).toHaveLength(0);
  });

  it("refreshes an expiring oauth credential once and persists the rotation", async () => {
    const { path, store } = await tempStore();
    const refreshed: OAuthCredential[] = [];
    await store.modify("faux", async () => ({
      type: "oauth",
      access: "at-old",
      refresh: "rt-old",
      expires: Date.now() + 1_000, // inside the 5-minute validity floor
    }));
    const wrapped = withStoreAuth(fauxProvider({ refreshed }), store);

    const first = await wrapped.auth.apiKey?.resolve({ ctx: {} as never });
    expect(first?.auth.headers?.["Authorization"]).toBe("Bearer at-old+refreshed");
    expect(refreshed).toHaveLength(1);

    // Rotation persisted: the on-disk refresh token is the rotated one.
    const doc = JSON.parse(await readFile(path, "utf8"));
    expect(doc.providers.faux.credential.refresh).toBe("rt-old+rotated");

    // A second resolve sees the fresh credential and does NOT refresh again —
    // the single-chain property that keeps shared-nest units from forking
    // the rotation.
    const second = await wrapped.auth.apiKey?.resolve({ ctx: {} as never });
    expect(second?.auth.headers?.["Authorization"]).toBe("Bearer at-old+refreshed");
    expect(refreshed).toHaveLength(1);
  });

  it("wraps every builtin provider", async () => {
    const { store } = await tempStore();
    const providers = storeBackedProviders(store);
    expect(providers.length).toBeGreaterThan(3);
    for (const id of ["anthropic", "openai-codex", "xai"]) {
      expect(providers.some((p) => p.id === id)).toBe(true);
    }
  });
});

describe("describe (error rendering)", () => {
  it("serializes plain-object causes instead of [object Object]", () => {
    expect(describeCause({ status: 401, message: "invalid api key" })).toBe(
      '{"status":401,"message":"invalid api key"}',
    );
    expect(describeCause(new Error("boom"))).toBe("boom");
    expect(describeCause("plain")).toBe("plain");
  });
});
