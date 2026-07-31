/**
 * Pure mapping for owner-authored kind:30978 swarm definitions — no app
 * imports so node tests can exercise it directly. The fetch/query layer
 * lives in `swarmDefinition.ts`.
 *
 * The event JSON uses the exact snake_case field names of buzz-sdk's
 * `SwarmContent` (crates/buzz-sdk/src/swarm.rs): `name`, `leader_pubkey`,
 * `instructions`, `members[{pubkey, description}]`, `report_back`,
 * `evaluation_criteria`.
 */

export type SwarmMemberDefinition = {
  /** Member agent pubkey (64-char hex). */
  pubkey: string;
  /** What this agent should be assigned ("do bug fixes", …). */
  description: string;
};

export type SwarmDefinition = {
  /** Stable swarm id — the event's d-tag. */
  id: string;
  /** Display name; empty when the owner left it blank (UI shows a fallback). */
  name: string;
  /** Leader agent pubkey; empty on a malformed/partial definition. */
  leaderPubkey: string;
  /** Leader/manager instructions (the high-priority prompt block). */
  instructions: string;
  members: SwarmMemberDefinition[];
  /** Whether members are told to report back for leader evaluation. */
  reportBack: boolean;
  /** Owner-defined success criteria the leader evaluates reports against. */
  evaluationCriteria: string;
};

/** The subset of a relay event this module reads. */
export type SwarmEventLike = {
  id: string;
  created_at: number;
  content: string;
  tags: string[][];
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse a kind:30978 content body into a `SwarmDefinition`. Forgiving by
 * design: unknown fields are ignored, malformed JSON or fields yield the
 * empty defaults — an unreadable definition edits like an empty one.
 */
export function parseSwarmContent(
  id: string,
  content: string | null | undefined,
): SwarmDefinition {
  const empty: SwarmDefinition = {
    id,
    name: "",
    leaderPubkey: "",
    instructions: "",
    members: [],
    reportBack: false,
    evaluationCriteria: "",
  };
  if (!content) {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return empty;
  }
  const body = parsed as {
    name?: unknown;
    leader_pubkey?: unknown;
    instructions?: unknown;
    members?: unknown;
    report_back?: unknown;
    evaluation_criteria?: unknown;
  };
  const members: SwarmMemberDefinition[] = [];
  if (Array.isArray(body.members)) {
    for (const entry of body.members) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const member = entry as { pubkey?: unknown; description?: unknown };
      const pubkey = asString(member.pubkey).trim().toLowerCase();
      if (!pubkey) {
        continue;
      }
      members.push({ pubkey, description: asString(member.description) });
    }
  }
  return {
    id,
    name: asString(body.name),
    leaderPubkey: asString(body.leader_pubkey).trim().toLowerCase(),
    instructions: asString(body.instructions),
    members,
    reportBack: body.report_back === true,
    evaluationCriteria: asString(body.evaluation_criteria),
  };
}

/**
 * Serialize a `SwarmDefinition` into the kind:30978 content body buzz-sdk's
 * `SwarmContent` parses. The dialog owns the full definition state, so every
 * field is written explicitly (the SDK's never-wipe `Option` discipline only
 * matters for partial writers). Member pubkeys are normalized to lowercase;
 * rows without a pubkey are dropped.
 */
export function serializeSwarmContent(
  definition: Omit<SwarmDefinition, "id">,
): string {
  return JSON.stringify({
    name: definition.name,
    leader_pubkey: definition.leaderPubkey.trim().toLowerCase(),
    instructions: definition.instructions,
    members: definition.members
      .filter((member) => member.pubkey.trim() !== "")
      .map((member) => ({
        pubkey: member.pubkey.trim().toLowerCase(),
        description: member.description,
      })),
    report_back: definition.reportBack,
    evaluation_criteria: definition.evaluationCriteria,
  });
}

/**
 * Reduce a kind:30978 event list to the NIP-33 head per d-tag: highest
 * `created_at` wins, ties break to the lexicographically lowest event id
 * (the NIP-01 replaceable-event rule). Events without a d-tag are skipped.
 */
export function selectSwarmDefinitionHeads<T extends SwarmEventLike>(
  events: readonly T[],
): T[] {
  const headsById = new Map<string, T>();
  for (const event of events) {
    const dTag = event.tags.find((tag) => tag[0] === "d" && tag[1]);
    const swarmId = dTag?.[1];
    if (!swarmId) {
      continue;
    }
    const current = headsById.get(swarmId);
    if (
      !current ||
      event.created_at > current.created_at ||
      (event.created_at === current.created_at && event.id < current.id)
    ) {
      headsById.set(swarmId, event);
    }
  }
  return [...headsById.values()];
}

/** The d-tag of a swarm event, or null when absent. */
export function swarmEventId(event: SwarmEventLike): string | null {
  return event.tags.find((tag) => tag[0] === "d" && tag[1])?.[1] ?? null;
}

/**
 * Map raw kind:30978 events to parsed definitions: NIP-33 head per d-tag,
 * sorted by display order (named swarms alphabetically, then unnamed).
 */
export function mapSwarmEventsToDefinitions(
  events: readonly SwarmEventLike[],
): SwarmDefinition[] {
  return selectSwarmDefinitionHeads(events)
    .map((event) => parseSwarmContent(swarmEventId(event) ?? "", event.content))
    .filter((definition) => definition.id !== "")
    .sort((left, right) => {
      const leftName = left.name.trim();
      const rightName = right.name.trim();
      if (Boolean(leftName) !== Boolean(rightName)) {
        return leftName ? -1 : 1;
      }
      return (leftName || left.id).localeCompare(rightName || right.id);
    });
}
