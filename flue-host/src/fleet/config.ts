/**
 * fleet.toml — declarative fleet provisioning for flue-tier agents.
 *
 * One multi-use agent invite (minted in the desktop's Add agent dialog with
 * a uses budget) plus one fleet.toml describes N agents; the provisioning
 * loop (scripts/provision-fleet.ts) turns each entry into an env file and a
 * systemd unit on this host. Keypairs are generated host-side per agent —
 * no secret ever crosses machines, exactly like new-standalone-agent.sh.
 *
 * The parser below covers the deliberate TOML subset the schema uses —
 * `[fleet]`, repeated `[[agents]]`, the per-agent `[agents.sandbox]`
 * sub-table, string keys, string arrays, and bare booleans — so the
 * package stays dependency-free. Anything outside that subset is a hard
 * parse error, never a silent skip: a typo'd section or key must fail
 * provisioning loudly.
 */

/** Shared fleet-level settings applied to every agent entry. */
export type FleetSettings = {
  /** Relay websocket URL every agent connects to (ws:// or wss://). */
  relayUrl: string;
  /** Hex pubkey of the owner every claimant is attributed to. */
  ownerPubkey: string;
  /** Multi-use agent invite code (v2.…) shared by the whole fleet. */
  inviteCode: string;
  /** Unix user the units run as. */
  runUser: string;
  /** ACP agent command for every unit (default: the flue-acp install path). */
  agentCommand: string;
  /**
   * Optional EnvironmentFile added to every unit via a systemd drop-in —
   * the shared provider credential file (e.g. XAI_API_KEY), root-owned,
   * mirroring the buzz-acp-flue provider.conf pattern.
   */
  providerEnv?: string;
};

/**
 * Tier-agnostic sandbox policy (AGENT_OS_M0.md invariant 2). This schema is
 * OURS and stable; each tier adapter translates it to its native mechanism.
 * Authored per-agent in fleet.toml as `[agents.sandbox]`. Swapping tiers
 * must never require re-authoring these fields.
 */
export type AgentSandbox = {
  /** Selects the tier factory (`BUZZ_FLUE_SANDBOX`). Default: `local`. */
  tier: string;
  /** Egress allowlist in our vocab (`relay`, `host`, `host:port`). Default: []. */
  egress: string[];
  /** Heavy-tier escalation binding (M3); reserved. Default: false. */
  escalation: boolean;
  /** Filesystem scope (reserved for M2/M3). Default: `workspace`. */
  fsScope: string;
};

/** One provisioned agent: a unit, an env file, a keypair, a model. */
export type FleetAgent = {
  /** Unit/env slug: buzz-acp-<name>.service, /etc/buzz-agents/<name>.env. */
  name: string;
  /** BUZZ_ACP_PROFILE_NAME; defaults to `name`. */
  displayName: string;
  /** BUZZ_FLUE_MODEL (pi provider id, e.g. xai/grok-4.5). */
  model: string;
  /** BUZZ_ACP_RESPOND_TO; defaults to owner-only. */
  respondTo: "owner-only" | "allowlist" | "anyone" | "nobody";
  /** BUZZ_ACP_RESPOND_TO_ALLOWLIST; required iff respondTo = allowlist. */
  allowlist: string[];
  /** Sandbox policy; the default block selects the `local` tier. */
  sandbox: AgentSandbox;
};

const DEFAULT_SANDBOX: AgentSandbox = {
  tier: "local",
  egress: [],
  escalation: false,
  fsScope: "workspace",
};

const FS_SCOPES = new Set(["workspace"]);

export type FleetConfig = {
  fleet: FleetSettings;
  agents: FleetAgent[];
};

const DEFAULT_AGENT_COMMAND = "/usr/local/lib/buzz-flue-host/dist/main.js";

const NAME_RE = /^[a-z0-9-]+$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const RESPOND_TO = new Set(["owner-only", "allowlist", "anyone", "nobody"]);

/** A parse/validation failure with the offending line for context. */
export class FleetConfigError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = "FleetConfigError";
  }
}

type RawValue = string | string[] | boolean;
type RawTable = Map<string, RawValue>;

/**
 * Parse the fleet.toml subset: `[fleet]`, `[[agents]]`, the per-agent
 * `[agents.sandbox]` sub-table, `key = "string"`, `key = ["array", …]`,
 * `key = true|false`, comments, and blank lines. `sandboxes[i]` is the
 * sandbox sub-table for `agents[i]`, or undefined when the agent declares
 * no `[agents.sandbox]`.
 */
function parseTables(source: string): {
  fleet: RawTable;
  agents: RawTable[];
  sandboxes: (RawTable | undefined)[];
} {
  const fleet: RawTable = new Map();
  const agents: RawTable[] = [];
  const sandboxes: (RawTable | undefined)[] = [];
  let current: RawTable | null = null;
  let currentName = "";

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line === "[fleet]") {
      current = fleet;
      currentName = "fleet";
      continue;
    }
    if (line === "[[agents]]") {
      current = new Map();
      agents.push(current);
      sandboxes.push(undefined);
      currentName = "agents";
      continue;
    }
    if (line === "[agents.sandbox]") {
      // Sub-table of the most recent [[agents]] entry (standard TOML).
      if (agents.length === 0) {
        throw new FleetConfigError(
          "[agents.sandbox] must follow an [[agents]] entry",
          lineNo,
        );
      }
      if (sandboxes[agents.length - 1] !== undefined) {
        throw new FleetConfigError(
          "duplicate [agents.sandbox] for one agent",
          lineNo,
        );
      }
      current = new Map();
      sandboxes[agents.length - 1] = current;
      currentName = "agents.sandbox";
      continue;
    }
    if (line.startsWith("[")) {
      throw new FleetConfigError(
        `unknown section ${line} — expected [fleet], [[agents]], or [agents.sandbox]`,
        lineNo,
      );
    }

    const eq = line.indexOf("=");
    if (eq === -1 || current === null) {
      throw new FleetConfigError(
        current === null
          ? `key outside a section: ${line}`
          : `expected key = value, got: ${line}`,
        lineNo,
      );
    }
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    if (current.has(key)) {
      throw new FleetConfigError(`duplicate key ${key} in [${currentName}]`, lineNo);
    }
    current.set(key, parseValue(rawValue, lineNo));
  }

  return { fleet, agents, sandboxes };
}

function parseValue(raw: string, lineNo: number): RawValue {
  if (raw.startsWith('"')) {
    return parseString(raw, lineNo);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) {
      throw new FleetConfigError(`unterminated array: ${raw}`, lineNo);
    }
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => parseString(item.trim(), lineNo));
  }
  throw new FleetConfigError(
    `unsupported value ${raw} — only "strings", ["arrays"], and true/false`,
    lineNo,
  );
}

function parseString(raw: string, lineNo: number): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    throw new FleetConfigError(`expected a "quoted string", got ${raw}`, lineNo);
  }
  const body = raw.slice(1, -1);
  if (body.includes('"') || body.includes("\\")) {
    throw new FleetConfigError(
      `escapes and embedded quotes are not supported: ${raw}`,
      lineNo,
    );
  }
  return body;
}

function requireString(
  table: RawTable,
  key: string,
  section: string,
): string {
  const value = table.get(key);
  if (typeof value !== "string" || value === "") {
    throw new FleetConfigError(`[${section}] requires ${key} = "…"`);
  }
  return value;
}

function optionalString(
  table: RawTable,
  key: string,
  section: string,
): string | undefined {
  const value = table.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new FleetConfigError(`[${section}] ${key} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(
  table: RawTable,
  key: string,
  section: string,
): boolean | undefined {
  const value = table.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new FleetConfigError(`[${section}] ${key} must be true or false`);
  }
  return value;
}

function rejectUnknownKeys(
  table: RawTable,
  known: readonly string[],
  section: string,
): void {
  for (const key of table.keys()) {
    if (!known.includes(key)) {
      throw new FleetConfigError(`unknown key ${key} in [${section}]`);
    }
  }
}

const TIER_RE = /^[a-z0-9-]+$/;
/** `relay`, a bare host, or host:port (loose — the tier is the authority). */
const EGRESS_RE = /^(relay|[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]{1,5})?)$/;

/**
 * Parse and validate a `[agents.sandbox]` sub-table into an AgentSandbox.
 * Absent block → the default (local tier, no egress). The tier NAME is only
 * format-checked here; the tier registry is the runtime authority and fails
 * loudly at session start on an unregistered name (invariant 1).
 */
function parseSandbox(table: RawTable | undefined, section: string): AgentSandbox {
  if (table === undefined) return { ...DEFAULT_SANDBOX };
  rejectUnknownKeys(table, ["tier", "egress", "escalation", "fs_scope"], section);

  const tier = optionalString(table, "tier", section) ?? DEFAULT_SANDBOX.tier;
  if (!TIER_RE.test(tier)) {
    throw new FleetConfigError(`${section}.tier must be a lowercase slug, got "${tier}"`);
  }

  const rawEgress = table.get("egress");
  if (rawEgress !== undefined && !Array.isArray(rawEgress)) {
    throw new FleetConfigError(`${section}.egress must be an array of strings`);
  }
  const egress = Array.isArray(rawEgress) ? rawEgress : [];
  for (const entry of egress) {
    if (!EGRESS_RE.test(entry)) {
      throw new FleetConfigError(
        `${section}.egress entries must be "relay", a host, or host:port, got "${entry}"`,
      );
    }
  }

  const fsScope = optionalString(table, "fs_scope", section) ?? DEFAULT_SANDBOX.fsScope;
  if (!FS_SCOPES.has(fsScope)) {
    throw new FleetConfigError(
      `${section}.fs_scope must be one of ${[...FS_SCOPES].join(", ")}, got "${fsScope}"`,
    );
  }

  return {
    tier,
    egress,
    escalation: optionalBoolean(table, "escalation", section) ?? DEFAULT_SANDBOX.escalation,
    fsScope,
  };
}

/** Parse and validate a fleet.toml source string. */
export function parseFleetConfig(source: string): FleetConfig {
  const { fleet: rawFleet, agents: rawAgents, sandboxes: rawSandboxes } = parseTables(source);

  if (rawFleet.size === 0) {
    throw new FleetConfigError("missing [fleet] section");
  }
  rejectUnknownKeys(
    rawFleet,
    [
      "relay_url",
      "owner_pubkey",
      "invite_code",
      "run_user",
      "agent_command",
      "provider_env",
    ],
    "fleet",
  );

  const relayUrl = requireString(rawFleet, "relay_url", "fleet");
  if (!relayUrl.startsWith("ws://") && !relayUrl.startsWith("wss://")) {
    throw new FleetConfigError("fleet.relay_url must start with ws:// or wss://");
  }
  const ownerPubkey = requireString(rawFleet, "owner_pubkey", "fleet");
  if (!HEX64_RE.test(ownerPubkey)) {
    throw new FleetConfigError(
      "fleet.owner_pubkey must be 64-char lowercase hex",
    );
  }
  const inviteCode = requireString(rawFleet, "invite_code", "fleet");
  if (!inviteCode.startsWith("v2.")) {
    throw new FleetConfigError("fleet.invite_code must start with v2.");
  }

  const providerEnv = optionalString(rawFleet, "provider_env", "fleet");
  const fleet: FleetSettings = {
    relayUrl,
    ownerPubkey,
    inviteCode,
    runUser: requireString(rawFleet, "run_user", "fleet"),
    agentCommand:
      optionalString(rawFleet, "agent_command", "fleet") ??
      DEFAULT_AGENT_COMMAND,
    ...(providerEnv === undefined ? {} : { providerEnv }),
  };

  if (rawAgents.length === 0) {
    throw new FleetConfigError("at least one [[agents]] entry is required");
  }

  const seen = new Set<string>();
  const agents = rawAgents.map((table, index) => {
    const section = `agents[${index}]`;
    rejectUnknownKeys(
      table,
      ["name", "display_name", "model", "respond_to", "allowlist"],
      section,
    );

    const name = requireString(table, "name", section);
    if (!NAME_RE.test(name)) {
      throw new FleetConfigError(
        `${section}.name must be lowercase alphanumeric/dash, got "${name}"`,
      );
    }
    if (seen.has(name)) {
      throw new FleetConfigError(`duplicate agent name "${name}"`);
    }
    seen.add(name);

    const respondTo =
      optionalString(table, "respond_to", section) ?? "owner-only";
    if (!RESPOND_TO.has(respondTo)) {
      throw new FleetConfigError(
        `${section}.respond_to must be owner-only, allowlist, anyone, or nobody`,
      );
    }

    const rawAllowlist = table.get("allowlist");
    const allowlist = Array.isArray(rawAllowlist) ? rawAllowlist : [];
    for (const entry of allowlist) {
      if (!HEX64_RE.test(entry)) {
        throw new FleetConfigError(
          `${section}.allowlist entries must be 64-char lowercase hex`,
        );
      }
    }
    if (respondTo === "allowlist" && allowlist.length === 0) {
      throw new FleetConfigError(
        `${section}: respond_to = "allowlist" requires a non-empty allowlist`,
      );
    }
    if (respondTo !== "allowlist" && rawAllowlist !== undefined) {
      throw new FleetConfigError(
        `${section}: allowlist is only valid with respond_to = "allowlist"`,
      );
    }

    return {
      name,
      displayName: optionalString(table, "display_name", section) ?? name,
      model: requireString(table, "model", section),
      respondTo: respondTo as FleetAgent["respondTo"],
      allowlist,
      sandbox: parseSandbox(rawSandboxes[index], `${section}.sandbox`),
    };
  });

  return { fleet, agents };
}
