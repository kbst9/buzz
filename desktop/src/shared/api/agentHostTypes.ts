/**
 * Agent-host (`BackendKind::Host`) API types — hosts discovered from kind
 * 30178 announcements and inputs for the relay-controlled agent lifecycle.
 * Re-exported through `./types` so call sites keep one import path.
 */

/** One runtime advertised by an agent host (kind 30178 announcement). */
export type AgentHostRuntime = {
  id: string;
  label: string;
};

/** A discovered agent host (kind 30178 announcement + local TOFU state). */
export type AgentHostInfo = {
  hostPubkey: string;
  hostId: string;
  label: string;
  version: string;
  runtimes: AgentHostRuntime[];
  maxAgents: number;
  deployed: number;
  /** Whether the user has explicitly accepted this host's pubkey. */
  accepted: boolean;
};

/** Input for creating an agent on a remote host. */
export type CreateHostAgentInput = {
  hostPubkey: string;
  /** Runtime id from the host's announcement. */
  runtime: string;
  name: string;
  personaId?: string;
  systemPrompt?: string;
  model?: string;
  provider?: string;
  envVars?: Record<string, string>;
};
