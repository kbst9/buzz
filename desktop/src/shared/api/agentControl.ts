import { sendAgentObserverControl } from "@/shared/api/observerRelay";
import { invokeTauri } from "@/shared/api/tauri";
import type { CancelManagedAgentTurnResult } from "@/shared/api/types";

/**
 * Publish (or update) a connected agent's owner-authored kind:30177
 * definition. The agent's harness reads `system_prompt` from it into its
 * `[System]` section at each new session — instructions reach the agent
 * without host access. Empty instructions publish an explicit clear.
 */
export async function setConnectedAgentInstructions(input: {
  agentPubkey: string;
  agentName: string;
  instructions: string;
}): Promise<void> {
  await invokeTauri<void>("set_connected_agent_instructions", {
    agentPubkey: input.agentPubkey,
    agentName: input.agentName,
    instructions: input.instructions,
  });
}

export async function cancelManagedAgentTurn(
  pubkey: string,
  channelId: string,
): Promise<CancelManagedAgentTurnResult> {
  await sendAgentObserverControl(pubkey, {
    type: "cancel_turn",
    channelId,
  });
  return { status: "sent" };
}

/**
 * Send a live model-switch control frame to a running agent. The switch rides
 * the harness's cancel-switch-requeue path (busy turn) or invalidate-and-reapply
 * (idle); the outcome arrives asynchronously as a `control_result` observer
 * frame, not as the return value here. This is fire-and-forget on the send side.
 */
export async function switchManagedAgentModel(
  pubkey: string,
  channelId: string,
  modelId: string,
): Promise<void> {
  await sendAgentObserverControl(pubkey, {
    type: "switch_model",
    channelId,
    modelId,
  });
}

/**
 * Ask a standalone agent to update its own kind:0 profile. Rides the same
 * owner-gated, NIP-44-encrypted control channel as cancel/switch; the
 * harness applies its tag-preserving merge and republishes. Fire-and-forget:
 * the durable confirmation is the profile event itself changing — poll the
 * profile after sending. Field semantics: omitted = untouched, "" = clear.
 */
export async function setConnectedAgentProfile(
  pubkey: string,
  fields: { name?: string; about?: string; avatarUrl?: string },
): Promise<void> {
  await sendAgentObserverControl(pubkey, {
    type: "set_profile",
    ...fields,
  });
}
