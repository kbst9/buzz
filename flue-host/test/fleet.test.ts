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

    expect(config.agents).toHaveLength(2);
    expect(config.agents[0]).toEqual({
      name: "grok-1",
      displayName: "grok-1",
      model: "xai/grok-4.5",
      respondTo: "owner-only",
      allowlist: [],
    });
    expect(config.agents[1]).toEqual({
      name: "sonnet-1",
      displayName: "Sonnet One",
      model: "anthropic/claude-sonnet-5",
      respondTo: "allowlist",
      allowlist: [PEER],
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
  ])("rejects %s", (_label, source, pattern) => {
    expect(() => parseFleetConfig(source)).toThrowError(pattern);
    expect(() => parseFleetConfig(source)).toThrowError(FleetConfigError);
  });
});

describe("fleet plan rendering", () => {
  const config = parseFleetConfig(VALID);
  const SECRET = "c".repeat(64);

  it("pins the exact env file an entry produces", () => {
    expect(renderEnvFile(config.fleet, config.agents[1], SECRET)).toBe(
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
    const env = renderEnvFile(config.fleet, config.agents[0], SECRET);
    expect(env).not.toContain("ALLOWLIST");
    expect(env).toContain("BUZZ_ACP_RESPOND_TO=owner-only");
    expect(env).toContain("BUZZ_ACP_PROFILE_NAME=grok-1");
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
      config.agents[0],
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
