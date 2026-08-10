import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { finalizeEvent, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import { log } from "../log.js";
import { InitChain } from "./initchain.js";

/**
 * Host-side signing broker (M5): holds the agent's Nostr private key so the
 * sandboxed `buzz` CLI never does. The sandbox gets `BUZZ_SIGNER_SOCKET`
 * instead of `BUZZ_PRIVATE_KEY`; every industry pattern we audited (srt
 * credential masking, microsandbox placeholder swap, OpenSandbox vault, nono)
 * keeps secrets outside the exec boundary — this is our equivalent for
 * in-process Nostr signing, which none of their HTTP-shaped vaults cover.
 *
 * Wire protocol (mirrors buzz-cli's `signer.rs` exactly — one request per
 * connection, newline-delimited JSON):
 *
 *   -> {"op":"get_public_key"}
 *   <- {"ok":true,"result":"<64-hex pubkey>"}
 *   -> {"op":"sign_event","event":{<NIP-01 unsigned event JSON>}}
 *   <- {"ok":true,"result":{<full signed event>}}
 *   -> {"op":"nip44_conversation_key","peer":"<64-hex>"}
 *   <- {"ok":true,"result":"<64-hex conversation key>"}
 *   <- {"ok":false,"error":"<detail>"}
 *
 * The socket lives INSIDE the session workspace (`<cwd>/.signer.sock`) on
 * purpose: every tier already projects the workspace (local trivially, srt
 * via its cwd allow-read, docker via the workspace bind-mount), so no tier
 * needs socket-specific plumbing. The worst an agent can do to it is delete
 * the socket file — self-DoS, healed on the next session start. The KEY
 * never crosses the socket in either direction; `nip44_conversation_key`
 * returns only the per-peer lane key (cannot sign, cannot recover the
 * master secret).
 */

const SOCKET_BASENAME = ".signer.sock";
/** Cap on a request line — an unsigned event is well under this. */
const MAX_REQUEST_BYTES = 262_144;

interface Broker {
  socketPath: string;
  server: net.Server;
}

/** Live brokers keyed by socket path (one per workspace in this process). */
const brokers = new Map<string, Broker>();
/** Retries a failed bind on the next call instead of poisoning the chain. */
const initChain = new InitChain("signing broker");

/** The socket path the sandbox env advertises for a given workspace. */
export function signerSocketPath(cwd: string): string {
  return path.join(path.resolve(cwd), SOCKET_BASENAME);
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function handleRequest(
  line: string,
  secretKey: Uint8Array,
  pubkeyHex: string,
): { ok: boolean; result?: unknown; error?: string } {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  switch (request["op"]) {
    case "get_public_key":
      return { ok: true, result: pubkeyHex };

    case "sign_event": {
      const event = request["event"] as Record<string, unknown> | undefined;
      if (typeof event !== "object" || event === null) {
        return { ok: false, error: "sign_event: missing event" };
      }
      // The broker signs as ITS identity only — a template naming another
      // pubkey is a protocol error, not something to silently rewrite.
      if (event["pubkey"] !== undefined && event["pubkey"] !== pubkeyHex) {
        return { ok: false, error: "sign_event: pubkey mismatch" };
      }
      if (
        typeof event["kind"] !== "number" ||
        typeof event["created_at"] !== "number" ||
        typeof event["content"] !== "string" ||
        !Array.isArray(event["tags"])
      ) {
        return { ok: false, error: "sign_event: malformed unsigned event" };
      }
      const signed = finalizeEvent(
        {
          kind: event["kind"],
          created_at: event["created_at"],
          content: event["content"],
          tags: event["tags"] as string[][],
        },
        secretKey,
      );
      if (!verifyEvent(signed)) {
        return { ok: false, error: "sign_event: self-verification failed" };
      }
      // Observability parity with the exec audit log: what was signed, never
      // the content (it may carry user text) and never any key material.
      log.info("broker signed event", {
        kind: signed.kind,
        id: signed.id,
        content_sha256: createHash("sha256").update(signed.content).digest("hex").slice(0, 16),
      });
      return { ok: true, result: signed };
    }

    case "nip44_conversation_key": {
      const peer = request["peer"];
      if (typeof peer !== "string" || !/^[0-9a-f]{64}$/.test(peer)) {
        return { ok: false, error: "nip44_conversation_key: peer must be 64-hex" };
      }
      const key = nip44.getConversationKey(secretKey, peer);
      log.info("broker issued conversation key", { peer: peer.slice(0, 8) });
      return { ok: true, result: Buffer.from(key).toString("hex") };
    }

    default:
      return { ok: false, error: `unknown op ${String(request["op"])}` };
  }
}

/**
 * Ensure a broker serves `cwd`'s socket for the given key. Idempotent per
 * workspace; serialized like the tier managers. Returns the socket path to
 * advertise as `BUZZ_SIGNER_SOCKET`.
 */
export async function ensureSigningBroker(
  cwd: string,
  privateKeyHex: string,
): Promise<string> {
  const socketPath = signerSocketPath(cwd);
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) {
    // Fleet unit envs carry 64-hex keys (buzz keys generate). nsec input
    // would silently derive garbage — refuse loudly instead.
    throw new Error("signing broker requires a 64-hex private key (nsec unsupported)");
  }
  await initChain.run(socketPath, async () => {
    const known = brokers.get(socketPath);
    if (known) {
      // The socket file lives in the agent-writable workspace: an agent (or
      // a cleanup job) can delete it, which self-DoSes signing. Re-check the
      // file each session start and re-bind when it vanished — the listener
      // itself survives, only the filesystem name needs restoring.
      try {
        await fs.access(socketPath);
        return;
      } catch {
        log.warn("signer socket file vanished; re-binding", { socket: socketPath });
        await new Promise<void>((resolve) => known.server.close(() => resolve()));
        brokers.delete(socketPath);
      }
    }
    const secretKey = hexToBytes(privateKeyHex);
    const pubkeyHex = getPublicKey(secretKey);

    // A stale socket file from a dead process blocks bind — remove it.
    await fs.rm(socketPath, { force: true });

    const server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_REQUEST_BYTES) {
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline).trim();
        const response = handleRequest(line, secretKey, pubkeyHex);
        socket.end(`${JSON.stringify(response)}\n`);
      });
      socket.on("error", () => socket.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    // Owner-only: the run user (and the sandbox running as the same UID).
    await fs.chmod(socketPath, 0o600);
    brokers.set(socketPath, { socketPath, server });
    log.info("signing broker listening", { socket: socketPath, pubkey: pubkeyHex });
  });
  return socketPath;
}

/** Test-only: close all brokers and remove their socket files. */
export async function resetSigningBrokersForTests(): Promise<void> {
  await initChain.idle();
  initChain.clearFailures();
  for (const broker of brokers.values()) {
    await new Promise<void>((resolve) => broker.server.close(() => resolve()));
    await fs.rm(broker.socketPath, { force: true });
  }
  brokers.clear();
}
