import { describe, expect, it } from "vitest";
import {
  FleetConfigError,
  parseFleetConfig,
} from "../src/fleet/config.js";
import {
  agentPaths,
  renderEnvFile,
  renderProviderDropIn,
  renderUnitFile,
} from "../src/fleet/plan.js";

const OWNER = "a".repeat(64);
const PEER = "b".repeat(64);

const VALID = `# Dreadnought fleet
[fleet]
relay_url = "wss://buzz.example.com"
owner_pubkey = "${OWNER}"
invite_code = "v2.abc123"
run_user = "kbs"
provider_env = "/etc/buzz-agents/flue-provider.env"

[[agents]]
name = "grok-1"
model = "xai/grok-4.5"

[[agents]]
name = "sonnet-1"
display_name = "Sonnet One"
model = "anthropic/claude-sonnet-5"
respond_to = "allowlist"
allowlist = ["${PEER}"]
`;

describe("parseFleetConfig", () => {
  it("parses the documented schema with per-entry defaults applied", () => {
    const config = parseFleetConfig(VALID);

    expect(config.fleet).toEqual({
      relayUrl: "wss://buzz.example.com",
      ownerPubkey: OWNER,
      inviteCode: "v2.abc123",
      runUser: "kbs",
      // Omitted agent_command falls back to the standard install path.
      agentCommand: "/usr/local/lib/buzz-flue-host/dist/main.js",
      providerEnv: "/etc/buzz-agents/flue-provider.env",
    });

    const DEFAULT_SANDBOX = {
      tier: "local",
      egress: [],
      escalation: false,
      fsScope: "workspace",
    };
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0]).toEqual({
      name: "grok-1",
      displayName: "grok-1",
      model: "xai/grok-4.5",
      respondTo: "owner-only",
      allowlist: [],
      // No [agents.sandbox] block → the default policy (local tier).
      sandbox: DEFAULT_SANDBOX,
    });
    expect(config.agents[1]).toEqual({
      name: "sonnet-1",
      displayName: "Sonnet One",
      model: "anthropic/claude-sonnet-5",
      respondTo: "allowlist",
      allowlist: [PEER],
      sandbox: DEFAULT_SANDBOX,
    });
  });

  it("parses a [agents.sandbox] block into the tier-agnostic policy", () => {
    const source = `[fleet]
relay_url = "wss://buzz.example.com"
owner_pubkey = "${OWNER}"
invite_code = "v2.abc123"
run_user = "kbs"

[[agents]]
name = "canary"
model = "xai/grok-4.5"
[agents.sandbox]
tier = "srt"
egress = ["relay", "api.x.ai", "127.0.0.1:8080"]
escalation = true
fs_scope = "workspace"

[[agents]]
name = "plain"
model = "xai/grok-4.5"
`;
    const config = parseFleetConfig(source);
    expect(config.agents[0]?.sandbox).toEqual({
      tier: "srt",
      egress: ["relay", "api.x.ai", "127.0.0.1:8080"],
      escalation: true,
      fsScope: "workspace",
    });
    // A sibling entry with no block still gets the default policy.
    expect(config.agents[1]?.sandbox).toEqual({
      tier: "local",
      egress: [],
      escalation: false,
      fsScope: "workspace",
    });
  });

  it.each([
    ["missing [fleet]", `[[agents]]\nname = "a"\nmodel = "m"`, /missing \[fleet\]/],
    [
      "no agents",
      `[fleet]\nrelay_url = "wss://x"\nowner_pubkey = "${OWNER}"\ninvite_code = "v2.z"\nrun_user = "kbs"`,
      /at least one \[\[agents\]\]/,
    ],
    [
      "bad relay scheme",
      VALID.replace('"wss://buzz.example.com"', '"https://buzz.example.com"'),
      /relay_url/,
    ],
    [
      "bad owner pubkey",
      VALID.replace(`"${OWNER}"`, '"nothex"'),
      /owner_pubkey/,
    ],
    [
      "bad invite prefix",
      VALID.replace('"v2.abc123"', '"v1.abc123"'),
      /invite_code/,
    ],
    [
      "duplicate agent name",
      `${VALID}\n[[agents]]\nname = "grok-1"\nmodel = "m"\n`,
      /duplicate agent name/,
    ],
    [
      "uppercase agent name",
      VALID.replace('"grok-1"', '"Grok-1"'),
      /lowercase/,
    ],
    [
      "allowlist without respond_to",
      VALID.replace('respond_to = "allowlist"\n', ""),
      /only valid with respond_to/,
    ],
    [
      "allowlist mode without entries",
      VALID.replace(`allowlist = ["${PEER}"]\n`, ""),
      /requires a non-empty allowlist/,
    ],
    [
      "unknown section",
      `${VALID}\n[extras]\nfoo = "bar"\n`,
      /unknown section/,
    ],
    [
      "unknown key",
      `${VALID.replace('model = "xai/grok-4.5"', 'model = "xai/grok-4.5"\ntemperature = "1"')}`,
      /unknown key temperature/,
    ],
    [
      "non-string value",
      VALID.replace('run_user = "kbs"', "run_user = 42"),
      /unsupported value/,
    ],
    [
      "sandbox before any agent",
      `[fleet]\nrelay_url = "wss://x"\nowner_pubkey = "${OWNER}"\ninvite_code = "v2.z"\nrun_user = "kbs"\n[agents.sandbox]\ntier = "srt"\n`,
      /\[agents\.sandbox\] must follow/,
    ],
    [
      "unknown sandbox key",
      `${VALID}[agents.sandbox]\nfoo = "bar"\n`,
      /unknown key foo/,
    ],
    [
      "bad sandbox tier",
      `${VALID}[agents.sandbox]\ntier = "SRT"\n`,
      /tier must be a lowercase slug/,
    ],
    [
      "bad egress entry",
      `${VALID}[agents.sandbox]\ntier = "srt"\negress = ["http://x"]\n`,
      /egress entries must be/,
    ],
    [
      "bad fs_scope",
      `${VALID}[agents.sandbox]\ntier = "srt"\nfs_scope = "host"\n`,
      /fs_scope must be one of/,
    ],
    [
      "non-boolean escalation",
      `${VALID}[agents.sandbox]\ntier = "srt"\nescalation = "yes"\n`,
      /escalation must be true or false/,
    ],
  ])("rejects %s", (_label, source, pattern) => {
    expect(() => parseFleetConfig(source)).toThrowError(pattern);
    expect(() => parseFleetConfig(source)).toThrowError(FleetConfigError);
  });
});

describe("fleet plan rendering", () => {
  const config = parseFleetConfig(VALID);
  const [grokAgent, sonnetAgent] = config.agents;
  if (!grokAgent || !sonnetAgent) {
    throw new Error("fixture must parse to two agents");
  }
  const SECRET = "c".repeat(64);

  it("pins the exact env file an entry produces", () => {
    expect(renderEnvFile(config.fleet, sonnetAgent, SECRET)).toBe(
      `BUZZ_RELAY_URL=wss://buzz.example.com
BUZZ_PRIVATE_KEY=${SECRET}
BUZZ_INVITE_CODE=v2.abc123
BUZZ_ACP_AGENT_OWNER=${OWNER}
BUZZ_ACP_RESPOND_TO=allowlist
BUZZ_ACP_RESPOND_TO_ALLOWLIST=${PEER}
BUZZ_ACP_AGENT_COMMAND=/usr/local/lib/buzz-flue-host/dist/main.js
BUZZ_FLUE_MODEL=anthropic/claude-sonnet-5
BUZZ_ACP_RELAY_OBSERVER=true
BUZZ_ACP_PROFILE_NAME=Sonnet One
`,
    );
  });

  it("omits the allowlist line outside allowlist mode", () => {
    const env = renderEnvFile(config.fleet, grokAgent, SECRET);
    expect(env).not.toContain("ALLOWLIST");
    expect(env).toContain("BUZZ_ACP_RESPOND_TO=owner-only");
    expect(env).toContain("BUZZ_ACP_PROFILE_NAME=grok-1");
  });

  it("omits sandbox env lines for the default (local, no egress) policy", () => {
    const env = renderEnvFile(config.fleet, grokAgent, SECRET);
    expect(env).not.toContain("BUZZ_FLUE_SANDBOX");
    expect(env).not.toContain("BUZZ_FLUE_EGRESS");
  });

  it("emits BUZZ_FLUE_SANDBOX and BUZZ_FLUE_EGRESS from a sandbox block", () => {
    const srtConfig = parseFleetConfig(`[fleet]
relay_url = "wss://buzz.example.com"
owner_pubkey = "${OWNER}"
invite_code = "v2.abc123"
run_user = "kbs"

[[agents]]
name = "canary"
model = "xai/grok-4.5"
[agents.sandbox]
tier = "srt"
egress = ["relay", "api.x.ai"]
`);
    const canary = srtConfig.agents[0];
    if (!canary) throw new Error("fixture must parse one agent");
    const env = renderEnvFile(srtConfig.fleet, canary, SECRET);
    expect(env).toContain("BUZZ_FLUE_SANDBOX=srt");
    expect(env).toContain("BUZZ_FLUE_EGRESS=relay,api.x.ai");
  });

  it("pins the unit file and paths to the standalone-agent shape", () => {
    const paths = agentPaths("grok-1");
    expect(paths).toEqual({
      envFile: "/etc/buzz-agents/grok-1.env",
      unitFile: "/etc/systemd/system/buzz-acp-grok-1.service",
      unitName: "buzz-acp-grok-1",
      dropInDir: "/etc/systemd/system/buzz-acp-grok-1.service.d",
      dropInFile: "/etc/systemd/system/buzz-acp-grok-1.service.d/provider.conf",
    });

    const unit = renderUnitFile(
      config.fleet,
      grokAgent,
      "/usr/local/bin/buzz-acp",
    );
    expect(unit).toContain("Description=Buzz ACP agent (grok-1)");
    expect(unit).toContain("User=kbs");
    expect(unit).toContain("EnvironmentFile=/etc/buzz-agents/grok-1.env");
    expect(unit).toContain("ExecStart=/usr/local/bin/buzz-acp --agents 2");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  it("renders the provider drop-in as a single EnvironmentFile stanza", () => {
    expect(renderProviderDropIn("/etc/buzz-agents/flue-provider.env")).toBe(
      "[Service]\nEnvironmentFile=/etc/buzz-agents/flue-provider.env\n",
    );
  });
});
