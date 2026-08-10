/**
 * NIP-PC host credential store — the flue-host side of the contract with
 * buzz-acp's credential sink (`crates/buzz-acp/src/credential_sink.rs`).
 *
 * The sink materializes owner-delivered provider credentials into
 * `credentials.json`; this module reads them through pi-ai's
 * `CredentialStore` seam and owns OAuth refresh write-back, so a rotated key
 * or token applies on the next model call with no restart.
 *
 * # Store document (shared schema, Rust writer / TS reader-writer)
 *
 * ```json
 * {
 *   "version": 1,
 *   "providers": {
 *     "anthropic": {
 *       "credential": { "type": "oauth", "access": "…", "refresh": "…", "expires": 0 },
 *       "deliveredCreatedAt": 1754800000,
 *       "updatedAt": 1754800000
 *     }
 *   }
 * }
 * ```
 *
 * # Cross-process lock protocol (keep in lockstep with the Rust side)
 *
 * Writers coordinate through a sidecar lockfile `credentials.json.lock`
 * created with `wx` (O_CREAT|O_EXCL): on contention, a lockfile whose mtime
 * is older than 30s is removed (crash takeover) and creation retried
 * immediately, otherwise retry every 25ms until the 5s acquisition timeout.
 * Release removes the file. Units sharing one nest share one OAuth refresh
 * chain: `modify()` re-reads under the lock, so a concurrent unit's refresh
 * is observed and never repeated (single-chain rotation).
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ApiKeyCredential,
  AuthResult,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
  Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { log } from "../log.js";

/** Store schema version this implementation reads and writes. */
const STORE_VERSION = 1;
/** Lockfile staleness threshold (crash takeover). */
const LOCK_STALE_MS = 30_000;
/** Lock acquisition retry interval. */
const LOCK_RETRY_MS = 25;
/** Lock acquisition timeout. */
const LOCK_TIMEOUT_MS = 5_000;
/** Refresh OAuth credentials with less than this much validity remaining —
 * pi's own `minOAuthValidityMs` default. */
const OAUTH_MIN_VALIDITY_MS = 5 * 60 * 1000;

interface StoreEntry {
  credential?: unknown;
  deliveredCreatedAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

interface StoreDoc {
  version?: number;
  providers?: Record<string, StoreEntry>;
  [key: string]: unknown;
}

/** Timing knobs, injectable for tests. */
export interface FileCredentialStoreOptions {
  lockStaleMs?: number;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal shape check: a pi credential is an object with a string `type`. */
function asCredential(value: unknown): Credential | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  if (type !== "api_key" && type !== "oauth") return undefined;
  return value as Credential;
}

/**
 * Acquire the cross-process store lock. Returns a release function.
 * Exported for the lock-contention tests.
 */
export async function acquireStoreLock(
  storePath: string,
  options: FileCredentialStoreOptions = {},
): Promise<() => Promise<void>> {
  const staleMs = options.lockStaleMs ?? LOCK_STALE_MS;
  const timeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
  const lockPath = `${storePath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const info = await stat(lockPath);
        stale = Date.now() - info.mtimeMs > staleMs;
      } catch {
        // Holder released between our create attempt and stat — retry now.
        continue;
      }
      if (stale) {
        // Crash takeover. Removal races are safe: the loser's `wx` create
        // simply fails again and it re-enters the loop.
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring ${lockPath} after ${timeoutMs}ms`);
      }
      await sleep(retryMs);
    }
  }
}

/**
 * File-backed pi `CredentialStore` over the NIP-PC store document.
 *
 * Reads are cached by `(mtimeMs, size)` so per-request `read()` calls cost a
 * `stat`. `modify()` is the only write path: per-provider promise chain
 * in-process (pi's contract) plus the cross-process lockfile, with a fresh
 * re-read under the lock.
 */
export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  readonly #options: FileCredentialStoreOptions;
  #cache: { mtimeMs: number; size: number; doc: StoreDoc } | undefined;
  #chains = new Map<string, Promise<unknown>>();

  constructor(path: string, options: FileCredentialStoreOptions = {}) {
    this.path = path;
    this.#options = options;
  }

  /** `BUZZ_FLUE_CREDENTIALS` override, else `~/.buzz/credentials.json` (the
   * default nest — where buzz-acp's sink writes). */
  static defaultPath(env: Record<string, string | undefined> = process.env): string {
    const configured = env["BUZZ_FLUE_CREDENTIALS"]?.trim();
    if (configured) return configured;
    return join(homedir(), ".buzz", "credentials.json");
  }

  async #load(fresh = false): Promise<StoreDoc> {
    let info;
    try {
      info = await stat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#cache = undefined;
        return { version: STORE_VERSION, providers: {} };
      }
      throw error;
    }
    if (
      !fresh &&
      this.#cache &&
      this.#cache.mtimeMs === info.mtimeMs &&
      this.#cache.size === info.size
    ) {
      return this.#cache.doc;
    }
    const text = await readFile(this.path, "utf8");
    // A corrupt store is an error, not an empty store — clobbering it could
    // destroy rotated OAuth state (mirrors the Rust sink's fail-closed rule).
    const doc = JSON.parse(text) as StoreDoc;
    if (typeof doc !== "object" || doc === null) {
      throw new Error(`credential store ${this.path} is not a JSON object`);
    }
    this.#cache = { mtimeMs: info.mtimeMs, size: info.size, doc };
    return doc;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const doc = await this.#load();
    return asCredential(doc.providers?.[providerId]?.credential);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const doc = await this.#load();
    const out: CredentialInfo[] = [];
    for (const [providerId, entry] of Object.entries(doc.providers ?? {})) {
      const credential = asCredential(entry?.credential);
      if (credential) out.push({ providerId, type: credential.type });
    }
    return out;
  }

  #enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#chains.set(
      providerId,
      next.catch(() => undefined),
    );
    return next;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#enqueue(providerId, async () => {
      const release = await acquireStoreLock(this.path, this.#options);
      try {
        const doc = await this.#load(true);
        const providers = (doc.providers ??= {});
        const existing = providers[providerId];
        const next = await fn(asCredential(existing?.credential));
        const nowSecs = Math.floor(Date.now() / 1000);
        if (next === undefined) {
          delete providers[providerId];
        } else {
          providers[providerId] = {
            ...existing,
            credential: next,
            updatedAt: nowSecs,
          };
        }
        doc.version ??= STORE_VERSION;
        const tmp = `${this.path}.tmp.${process.pid}`;
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
        await rename(tmp, this.path);
        this.#cache = undefined;
        return next;
      } finally {
        await release();
      }
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.modify(providerId, async () => undefined);
  }
}

/**
 * Refresh an OAuth credential if it is within the validity floor, persisting
 * the rotation through `modify()` so units sharing the store never fork the
 * refresh chain: the re-read under the lock observes a concurrent refresh
 * and skips its own.
 */
async function freshOAuthCredential(
  provider: Provider,
  store: FileCredentialStore,
  seen: OAuthCredential,
): Promise<OAuthCredential> {
  if (seen.expires - Date.now() > OAUTH_MIN_VALIDITY_MS) return seen;
  const next = await store.modify(provider.id, async (current) => {
    if (current?.type !== "oauth") return current;
    if (current.expires - Date.now() > OAUTH_MIN_VALIDITY_MS) return current;
    const oauth = provider.auth.oauth;
    if (!oauth) return current;
    return await oauth.refresh(current);
  });
  if (next?.type === "oauth") return next;
  throw new Error(`credential for ${provider.id} was removed during refresh`);
}

/**
 * Wrap a pi provider so auth resolution consults the NIP-PC store first:
 * stored `api_key` wins, stored `oauth` refreshes through the store and
 * derives request auth via the provider's own `toAuth` (keeping pi's exact
 * header semantics per provider), and an absent entry falls back to the
 * provider's ambient/env resolution unchanged.
 */
export function withStoreAuth(provider: Provider, store: FileCredentialStore): Provider {
  const base = provider.auth;
  const baseApiKey = base.apiKey;
  const resolve = async (input: {
    ctx: Parameters<NonNullable<typeof baseApiKey>["resolve"]>[0]["ctx"];
    credential?: ApiKeyCredential;
  }): Promise<AuthResult | undefined> => {
    let stored: Credential | undefined;
    try {
      stored = await store.read(provider.id);
    } catch (error) {
      log.warn("credential store read failed — falling back to env", {
        provider: provider.id,
        error: error instanceof Error ? error.message : String(error),
      });
      stored = undefined;
    }
    if (stored?.type === "api_key" && stored.key) {
      return {
        auth: { apiKey: stored.key },
        ...(stored.env ? { env: stored.env } : {}),
        source: "buzz credential store",
      };
    }
    if (stored?.type === "oauth" && base.oauth) {
      const fresh = await freshOAuthCredential(provider, store, stored);
      return {
        auth: await base.oauth.toAuth(fresh),
        source: "buzz credential store (oauth)",
      };
    }
    return baseApiKey ? baseApiKey.resolve(input) : undefined;
  };
  return {
    ...provider,
    auth: {
      ...base,
      apiKey: baseApiKey
        ? { ...baseApiKey, resolve }
        : { name: `${provider.name} (buzz credential store)`, resolve },
    },
  };
}

/** Every pi built-in provider, wrapped with store-aware auth resolution. */
export function storeBackedProviders(store: FileCredentialStore): Provider[] {
  return builtinProviders().map((provider) => withStoreAuth(provider, store));
}
