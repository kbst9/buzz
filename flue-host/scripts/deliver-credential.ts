/**
 * Deliver (or revoke) one NIP-PC provider credential to an agent — the
 * owner-side publisher the desktop AI-accounts pane will implement natively.
 * Until then this is the operator path for the Phase-0 smoke and for fleet
 * bring-up.
 *
 * Usage (from flue-host/, hermit active):
 *
 *   BUZZ_OWNER_PRIVATE_KEY=<64-hex> BUZZ_RELAY_URL=wss://buzz.example.com \
 *     pnpm exec tsx scripts/deliver-credential.ts \
 *       --agent <agent-pubkey-hex> --provider anthropic --login
 *
 *   … --provider xai --key-stdin          # paste an API key on stdin
 *   … --provider anthropic --revoke       # remove the provider's entry
 *
 * `--login` runs the provider's own pi-ai OAuth flow (Claude Pro/Max,
 * ChatGPT/Codex, Grok subscription): it prints the authorize URL or device
 * code, you approve in a browser, and the resulting OAuth pair is delivered.
 * The owner key signs the kind:30990 event and the NIP-98 request auth; it
 * is read from the environment once and never persisted.
 */

import { createInterface } from "node:readline/promises";
import { createHash, randomUUID } from "node:crypto";
import type { AuthInteraction, Credential } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";

const KIND_AGENT_PROVIDER_CREDENTIAL = 30990;
const KIND_HTTP_AUTH = 27235;

interface Args {
  agent: string;
  provider: string;
  mode: "login" | "key-stdin" | "revoke";
}

function usageExit(message?: string): never {
  if (message) console.error(`error: ${message}`);
  console.error(
    "usage: deliver-credential.ts --agent <64-hex> --provider <id> (--login | --key-stdin | --revoke)",
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  let agent: string | undefined;
  let provider: string | undefined;
  let mode: Args["mode"] | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent") agent = argv[(i += 1)];
    else if (arg === "--provider") provider = argv[(i += 1)];
    else if (arg === "--login") mode = "login";
    else if (arg === "--key-stdin") mode = "key-stdin";
    else if (arg === "--revoke") mode = "revoke";
    else usageExit(`unknown argument ${arg}`);
  }
  if (!agent || !/^[0-9a-f]{64}$/.test(agent)) usageExit("--agent must be 64 lowercase hex chars");
  if (!provider || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(provider)) {
    usageExit("--provider must match [a-z0-9][a-z0-9_-]{0,31}");
  }
  if (!mode) usageExit("one of --login / --key-stdin / --revoke is required");
  return { agent, provider, mode };
}

/** Console-backed pi login interaction: URLs/codes to stderr, answers from stdin. */
function consoleInteraction(): AuthInteraction {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  return {
    async prompt(prompt) {
      const answer = await readline.question(`${prompt.message}\n> `);
      return answer.trim();
    },
    notify(event) {
      switch (event.type) {
        case "auth_url":
          console.error(`\nOpen this URL in a browser and approve:\n  ${event.url}`);
          if (event.instructions) console.error(event.instructions);
          break;
        case "device_code":
          console.error(
            `\nVisit ${event.verificationUri} and enter code: ${event.userCode}`,
          );
          break;
        default:
          console.error(event.type === "info" ? event.message : `[${event.type}]`);
      }
    },
  };
}

async function obtainCredential(args: Args): Promise<Credential | undefined> {
  if (args.mode === "revoke") return undefined;
  if (args.mode === "key-stdin") {
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    const key = (await readline.question(`API key for ${args.provider}:\n> `)).trim();
    readline.close();
    if (!key) usageExit("empty API key");
    return { type: "api_key", key };
  }
  const provider = builtinProviders().find((candidate) => candidate.id === args.provider);
  if (!provider) usageExit(`unknown pi provider ${args.provider}`);
  const oauth = provider.auth.oauth;
  if (!oauth) usageExit(`provider ${args.provider} has no OAuth flow — use --key-stdin`);
  console.error(`Starting ${oauth.name} sign-in…`);
  const credential = await oauth.login(consoleInteraction());
  console.error("Sign-in complete.");
  return credential;
}

function relayHttpOrigin(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  url.pathname = "";
  url.search = "";
  return url.origin;
}

function nip98Header(secretKey: Uint8Array, url: string, body: Uint8Array): string {
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const auth = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", "POST"],
        ["nonce", randomUUID()],
        ["payload", payloadHash],
      ],
      content: "",
    },
    secretKey,
  );
  return `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ownerSecretHex = process.env["BUZZ_OWNER_PRIVATE_KEY"]?.trim();
  const relayUrl = process.env["BUZZ_RELAY_URL"]?.trim();
  if (!ownerSecretHex || !/^[0-9a-f]{64}$/.test(ownerSecretHex)) {
    usageExit("BUZZ_OWNER_PRIVATE_KEY must be set (64 lowercase hex chars)");
  }
  if (!relayUrl) usageExit("BUZZ_RELAY_URL must be set");
  const ownerSecret = Uint8Array.from(Buffer.from(ownerSecretHex, "hex"));
  const ownerPub = getPublicKey(ownerSecret);

  const credential = await obtainCredential(args);
  const payload =
    credential === undefined
      ? { v: 1, provider: args.provider, revoked: true }
      : { v: 1, provider: args.provider, credential };

  const conversationKey = nip44.v2.utils.getConversationKey(ownerSecret, args.agent);
  const ciphertext = nip44.v2.encrypt(JSON.stringify(payload), conversationKey);

  const event = finalizeEvent(
    {
      kind: KIND_AGENT_PROVIDER_CREDENTIAL,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", `${args.agent}:${args.provider}`],
        ["p", args.agent],
      ],
      content: ciphertext,
    },
    ownerSecret,
  );

  const origin = relayHttpOrigin(relayUrl);
  const url = `${origin}/events`;
  const body = Buffer.from(JSON.stringify(event));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: nip98Header(ownerSecret, url, body),
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`relay rejected delivery: HTTP ${response.status} ${text}`);
    process.exit(2);
  }
  console.log(
    JSON.stringify({
      v: 1,
      delivered: args.mode !== "revoke",
      provider: args.provider,
      agent: args.agent,
      owner: ownerPub,
      event_id: event.id,
      relay_response: text.slice(0, 200),
    }),
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
