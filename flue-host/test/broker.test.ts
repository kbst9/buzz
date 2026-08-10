import { mkdtemp, rm, stat } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import { afterAll, describe, expect, it } from "vitest";
import {
  ensureSigningBroker,
  resetSigningBrokersForTests,
} from "../src/sandbox/broker.js";

/**
 * Signing-broker unit tests (M5): the wire protocol as buzz-cli's signer.rs
 * speaks it — one request per connection, newline JSON — against a real
 * broker with a real key. Cross-implementation (Rust client ↔ Node broker)
 * correctness is proven by the live canary smoke; here we pin protocol
 * shape, signature validity, per-peer conversation keys, and the refusals.
 */

function request(socketPath: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => (buffer += chunk));
    socket.on("end", () => {
      try {
        resolve(JSON.parse(buffer.trim()) as Record<string, unknown>);
      } catch (cause) {
        reject(cause as Error);
      }
    });
    socket.write(`${JSON.stringify(body)}\n`);
  });
}

describe("signing broker", () => {
  const secretKey = generateSecretKey();
  const secretHex = Buffer.from(secretKey).toString("hex");
  const pubkeyHex = getPublicKey(secretKey);
  let workspace: string;
  let socketPath: string;

  afterAll(async () => {
    await resetSigningBrokersForTests();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("starts once per workspace, socket owner-only inside the workspace", async () => {
    workspace = await mkdtemp(join(tmpdir(), "broker-test-"));
    socketPath = await ensureSigningBroker(workspace, secretHex);
    expect(socketPath).toBe(join(workspace, ".signer.sock"));
    // Idempotent for the same workspace.
    expect(await ensureSigningBroker(workspace, secretHex)).toBe(socketPath);
    const mode = (await stat(socketPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("serves get_public_key", async () => {
    const response = await request(socketPath, { op: "get_public_key" });
    expect(response).toMatchObject({ ok: true, result: pubkeyHex });
  });

  it("signs a valid unsigned event; the signature verifies", async () => {
    const unsigned = {
      pubkey: pubkeyHex,
      created_at: 1_700_000_000,
      kind: 1,
      tags: [["t", "broker"]],
      content: "signed by the broker",
    };
    const response = await request(socketPath, { op: "sign_event", event: unsigned });
    expect(response["ok"]).toBe(true);
    const event = response["result"] as Parameters<typeof verifyEvent>[0];
    expect(event.pubkey).toBe(pubkeyHex);
    expect(event.kind).toBe(1);
    expect(verifyEvent(event)).toBe(true);
  });

  it("refuses to sign for a foreign pubkey", async () => {
    const foreign = getPublicKey(generateSecretKey());
    const response = await request(socketPath, {
      op: "sign_event",
      event: { pubkey: foreign, created_at: 1, kind: 1, tags: [], content: "" },
    });
    expect(response).toMatchObject({ ok: false });
    expect(String(response["error"])).toContain("pubkey mismatch");
  });

  it("issues the correct per-peer NIP-44 conversation key (symmetric)", async () => {
    const peerSecret = generateSecretKey();
    const peerPub = getPublicKey(peerSecret);
    const response = await request(socketPath, {
      op: "nip44_conversation_key",
      peer: peerPub,
    });
    expect(response["ok"]).toBe(true);
    const expected = Buffer.from(nip44.getConversationKey(secretKey, peerPub)).toString("hex");
    expect(response["result"]).toBe(expected);
    // Symmetry: the peer deriving toward us gets the same key.
    const fromPeer = Buffer.from(nip44.getConversationKey(peerSecret, pubkeyHex)).toString("hex");
    expect(response["result"]).toBe(fromPeer);
  });

  it("rejects malformed requests without dying", async () => {
    expect(await request(socketPath, { op: "explode" })).toMatchObject({ ok: false });
    expect(
      await request(socketPath, { op: "nip44_conversation_key", peer: "nothex" }),
    ).toMatchObject({ ok: false });
    expect(await request(socketPath, { op: "sign_event", event: { kind: "x" } })).toMatchObject({
      ok: false,
    });
    // Still alive after the garbage.
    expect(await request(socketPath, { op: "get_public_key" })).toMatchObject({ ok: true });
  });

  it("refuses non-hex private keys loudly", async () => {
    const other = await mkdtemp(join(tmpdir(), "broker-nsec-"));
    await expect(ensureSigningBroker(other, "nsec1notahexkey")).rejects.toThrow(/64-hex/);
    await rm(other, { recursive: true, force: true });
  });
});
