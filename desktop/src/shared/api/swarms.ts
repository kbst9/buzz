import { invokeTauri } from "@/shared/api/tauri";

export type PublishSwarmDefinitionResult = {
  eventId: string;
  accepted: boolean;
  message: string;
};

/**
 * Publish (or update) an owner-authored kind:30178 swarm definition.
 * `contentJson` is the serialized swarm content (buzz-sdk `SwarmContent`
 * field names, see `serializeSwarmContent`); `swarmId` is the stable d-tag.
 * Owner-signed and relayed like `setConnectedAgentInstructions` — the
 * leader's harness picks it up at its next session, even while offline now.
 */
export async function publishSwarmDefinition(input: {
  swarmId: string;
  contentJson: string;
}): Promise<PublishSwarmDefinitionResult> {
  const response = await invokeTauri<{
    event_id: string;
    accepted: boolean;
    message: string;
  }>("publish_swarm_definition", {
    swarmId: input.swarmId,
    contentJson: input.contentJson,
  });

  return {
    eventId: response.event_id,
    accepted: response.accepted,
    message: response.message,
  };
}
