import type { RelayEvent } from "@/shared/api/types";
import { invokeTauri } from "@/shared/api/tauri";

/**
 * Provider whose subscription account can be connected from the desktop. The
 * ids match `buzz-core`'s provider grammar and the pi-ai catalog. `flow`
 * drives the UI affordance; `supported` gates the Connect button until the
 * backend flow exists.
 */
export interface AiProvider {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  readonly flow: "oauth-browser" | "oauth-device" | "unit-tier";
  readonly supported: boolean;
}

/**
 * The providers offered in the pane. Anthropic and xAI have working
 * subscription sign-in; OpenAI Codex is a scaffolded follow-up; Cursor is a
 * separate agent tier (no embeddable subscription flow), shown for context.
 */
export const AI_PROVIDERS: readonly AiProvider[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    blurb: "Connect a Claude Pro or Max subscription.",
    flow: "oauth-browser",
    supported: true,
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    blurb: "Connect a SuperGrok or X Premium subscription.",
    flow: "oauth-device",
    supported: true,
  },
  {
    id: "openai-codex",
    label: "OpenAI",
    blurb: "ChatGPT subscription sign-in — coming soon.",
    flow: "oauth-device",
    supported: false,
  },
  {
    id: "cursor",
    label: "Cursor",
    blurb: "Runs as its own agent tier — configuration coming soon.",
    flow: "unit-tier",
    supported: false,
  },
] as const;

/** Non-secret account summary as returned by the Tauri backend. */
export interface AiAccountSummary {
  provider: string;
  kind: string;
  connectedAt: number;
}

/** Prompt payload emitted during an interactive OAuth login. */
export interface AiAccountOAuthPrompt {
  provider: string;
  kind: "auth_url" | "device_code" | "progress";
  url?: string;
  userCode?: string;
  verificationUri?: string;
  message?: string;
}

export function listAiAccounts(): Promise<AiAccountSummary[]> {
  return invokeTauri<AiAccountSummary[]>("list_ai_accounts");
}

export function removeAiAccount(provider: string): Promise<void> {
  return invokeTauri<void>("remove_ai_account", { provider });
}

/**
 * Run the provider subscription sign-in. Resolves with the stored account
 * summary; progress (browser URL / device code) arrives via the
 * `ai-account-oauth-prompt` Tauri event — subscribe before calling.
 */
export function aiAccountOAuthLogin(provider: string): Promise<AiAccountSummary> {
  return invokeTauri<AiAccountSummary>("ai_account_oauth_login", { provider });
}

/**
 * Build owner-signed kind:30990 delivery events (one per agent) for a stored
 * credential, or revocations when `revoke` is true. Returns parsed relay
 * events ready to publish; secrets never cross this boundary.
 */
export async function buildAiAccountDeliveryEvents(
  provider: string,
  agentPubkeys: string[],
  revoke: boolean,
): Promise<RelayEvent[]> {
  const eventJsons = await invokeTauri<string[]>(
    "build_ai_account_delivery_events",
    { provider, agentPubkeys, revoke },
  );
  return eventJsons.map((json) => JSON.parse(json) as RelayEvent);
}
