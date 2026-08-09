/**
 * Live-fleet smoke (AGENT_OS_M0.md § M0.3) — the scripted replacement for
 * the manual mention-and-watch loop. Runs ON the fleet host (gradient).
 *
 * What it does: sends a mention turn to one live agent from a sibling
 * identity (the codex-identity pattern: same-owner siblings fire each
 * other's turns even in respond_to=owner-only), inside the DEDICATED smoke
 * channel, then polls the thread for the agent's reply within a deadline
 * and greps the agent unit's journal window for ERROR lines.
 *
 * Usage (gradient):
 *   sudo -v && \
 *   SMOKE_SENDER_ENV=/etc/buzz-agents/codex.env \
 *   SMOKE_TARGET_PK=<agent hex pubkey> \
 *   SMOKE_CHANNEL=<smoke channel uuid> \
 *   SMOKE_UNIT=buzz-acp-flue \
 *   pnpm exec tsx scripts/fleet-smoke.ts
 *
 * Optional:
 *   SMOKE_DEADLINE_S  reply deadline, default 120
 *   BUZZ_BIN          buzz CLI path, default `buzz` then /usr/local/bin/buzz
 *   --frames [db]     owner-side only (the Mac): additionally require
 *                     observer frames for the target in the archive DB
 *                     window (default db: ~/.buzz/archive/archive.db)
 *
 * Output contract: human progress lines, then ONE JSON object (v: 1) as
 * the LAST stdout line. Enumerated exit codes so goal mode branches on
 * failure class, never on prose:
 *   0  pass
 *   2  no-reply-within-deadline
 *   3  evidence check failed after a reply (journal ERRORs, or --frames
 *      found none); JSON `reason` disambiguates
 *   4  send-failure (mint/publish of the smoke mention failed)
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface SmokeReport {
  v: 1;
  pass: boolean;
  reason: "pass" | "no-reply" | "journal-errors" | "frames-missing" | "send-failure";
  target_pk: string;
  channel: string;
  unit: string;
  sender_env: string;
  nonce: string;
  event_id: string | null;
  reply_event_id: string | null;
  reply_ms: number | null;
  journal_error_lines: number;
  frames_checked: boolean;
  frames_seen: number | null;
  deadline_s: number;
}

function fail(message: string): never {
  console.error(`fleet-smoke: ${message}`);
  process.exit(4);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

/**
 * Read a unit env file, escalating through sudo -n when direct read fails
 * (/etc/buzz-agents is root-only). Parse KEY=VALUE by FIRST '=' only — the
 * BUZZ_AUTH_TAG value is unquoted JSON containing '=' padding and commas;
 * shell-sourcing corrupts it (learned live 2026-07-29).
 */
async function readUnitEnv(path: string): Promise<Record<string, string>> {
  let content: string;
  try {
    content = (await execFileAsync("cat", [path])).stdout;
  } catch {
    try {
      content = (await execFileAsync("sudo", ["-n", "cat", path])).stdout;
    } catch {
      fail(`cannot read ${path} (run \`sudo -v\` first, or point SMOKE_SENDER_ENV at a readable copy)`);
    }
  }
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

function resolveBuzzBin(): string {
  const override = process.env["BUZZ_BIN"]?.trim();
  if (override) return override;
  return existsSync("/usr/local/bin/buzz") ? "/usr/local/bin/buzz" : "buzz";
}

interface BuzzIdentity {
  BUZZ_RELAY_URL: string;
  BUZZ_PRIVATE_KEY: string;
  BUZZ_AUTH_TAG?: string;
}

async function buzz(
  bin: string,
  identity: BuzzIdentity,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["--format", "compact", ...args], {
      env: { ...process.env, ...identity },
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? String(cause),
    };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const senderEnvPath = requireEnv("SMOKE_SENDER_ENV");
  const targetPk = requireEnv("SMOKE_TARGET_PK").toLowerCase();
  const channel = requireEnv("SMOKE_CHANNEL");
  const unit = requireEnv("SMOKE_UNIT");
  const deadlineS = Number(process.env["SMOKE_DEADLINE_S"] ?? "120");
  if (!Number.isFinite(deadlineS) || deadlineS <= 0) fail("SMOKE_DEADLINE_S must be a positive number");
  if (!/^[0-9a-f]{64}$/.test(targetPk)) fail("SMOKE_TARGET_PK must be 64-char hex");

  const framesFlagIndex = process.argv.indexOf("--frames");
  const framesDb =
    framesFlagIndex === -1
      ? null
      : (process.argv[framesFlagIndex + 1]?.startsWith("-") ?? true)
        ? join(homedir(), ".buzz/archive/archive.db")
        : (process.argv[framesFlagIndex + 1] as string);

  const unitEnv = await readUnitEnv(senderEnvPath);
  const relayUrl = unitEnv["BUZZ_RELAY_URL"];
  const privateKey = unitEnv["BUZZ_PRIVATE_KEY"];
  if (!relayUrl || !privateKey) fail(`${senderEnvPath} lacks BUZZ_RELAY_URL/BUZZ_PRIVATE_KEY`);
  const identity: BuzzIdentity = {
    BUZZ_RELAY_URL: relayUrl,
    BUZZ_PRIVATE_KEY: privateKey,
    ...(unitEnv["BUZZ_AUTH_TAG"] ? { BUZZ_AUTH_TAG: unitEnv["BUZZ_AUTH_TAG"] } : {}),
  };

  const bin = resolveBuzzBin();
  const nonce = randomBytes(4).toString("hex");
  const sentAtEpoch = Math.floor(Date.now() / 1000);
  const report: SmokeReport = {
    v: 1,
    pass: false,
    reason: "send-failure",
    target_pk: targetPk,
    channel,
    unit,
    sender_env: senderEnvPath,
    nonce,
    event_id: null,
    reply_event_id: null,
    reply_ms: null,
    journal_error_lines: 0,
    frames_checked: framesDb !== null,
    frames_seen: null,
    deadline_s: deadlineS,
  };

  const finish = (code: 0 | 2 | 3 | 4, human: string): never => {
    console.log(human);
    console.log(JSON.stringify(report));
    process.exit(code);
  };

  // ── Send the smoke mention ────────────────────────────────────────────────
  const content = `[fleet-smoke ${nonce}] Automated liveness probe — please reply in this thread with a brief acknowledgement.`;
  const sendStarted = Date.now();
  const sent = await buzz(bin, identity, [
    "messages",
    "send",
    "--channel",
    channel,
    "--content",
    content,
    "--mention",
    targetPk,
  ]);
  if (!sent.ok) {
    report.reason = "send-failure";
    return finish(4, `fleet-smoke SEND-FAILURE: ${sent.stderr.trim().slice(0, 300)}`);
  }
  let eventId: string | undefined;
  try {
    eventId = (JSON.parse(sent.stdout) as { event_id?: string }).event_id;
  } catch {
    /* fall through to the guard below */
  }
  if (!eventId) {
    report.reason = "send-failure";
    return finish(4, `fleet-smoke SEND-FAILURE: no event_id in send output: ${sent.stdout.trim().slice(0, 300)}`);
  }
  report.event_id = eventId;
  console.log(`fleet-smoke: sent ${eventId} (nonce ${nonce}) to ${targetPk.slice(0, 8)}… in ${channel}`);

  // ── Poll the thread for the target's reply ────────────────────────────────
  const deadline = sendStarted + deadlineS * 1000;
  let reply: { id: string } | undefined;
  while (Date.now() < deadline && !reply) {
    await sleep(3_000);
    const thread = await buzz(bin, identity, [
      "messages",
      "thread",
      "--channel",
      channel,
      "--event",
      eventId,
    ]);
    if (!thread.ok) continue; // transient relay/CLI hiccups keep polling
    try {
      const events = JSON.parse(thread.stdout) as {
        id: string;
        pubkey: string;
        created_at: number;
      }[];
      reply = events.find(
        (event) =>
          event.pubkey?.toLowerCase() === targetPk &&
          event.id !== eventId &&
          event.created_at >= sentAtEpoch - 5,
      );
    } catch {
      /* unparseable page — keep polling */
    }
  }

  if (!reply) {
    report.reason = "no-reply";
    return finish(
      2,
      `fleet-smoke NO-REPLY: ${targetPk.slice(0, 8)}… did not reply within ${deadlineS}s (event ${eventId})`,
    );
  }
  report.reply_event_id = reply.id;
  report.reply_ms = Date.now() - sendStarted;
  console.log(`fleet-smoke: reply ${reply.id} after ${(report.reply_ms / 1000).toFixed(1)}s`);

  // ── Journal window: ERROR lines since the send ────────────────────────────
  let journal = "";
  const journalArgs = ["-u", unit, "--since", `@${sentAtEpoch}`, "--no-pager", "-o", "cat"];
  try {
    journal = (await execFileAsync("journalctl", journalArgs)).stdout;
  } catch {
    try {
      journal = (await execFileAsync("sudo", ["-n", "journalctl", ...journalArgs])).stdout;
    } catch {
      console.log(`fleet-smoke: WARNING — journal for ${unit} unreadable; skipping journal gate`);
    }
  }
  const errorLines = journal.split("\n").filter((line) => /\bERROR\b/.test(line));
  report.journal_error_lines = errorLines.length;
  if (errorLines.length > 0) {
    report.reason = "journal-errors";
    return finish(
      3,
      `fleet-smoke JOURNAL-ERRORS: reply OK but ${errorLines.length} ERROR line(s) in ${unit} since send: ${errorLines[0]?.slice(0, 200)}`,
    );
  }

  // ── Optional owner-side frames check (archive.db) ─────────────────────────
  if (framesDb !== null) {
    try {
      // archived_events.pubkey is the frame AUTHOR (the agent under test);
      // identity_pubkey is the archive owner. Kind 24200 = observer frames.
      const query = `SELECT COUNT(*) FROM archived_events WHERE pubkey = '${targetPk}' AND kind = 24200 AND created_at >= ${sentAtEpoch};`;
      const { stdout } = await execFileAsync("sqlite3", [framesDb, query]);
      report.frames_seen = Number(stdout.trim());
    } catch (cause) {
      report.reason = "frames-missing";
      return finish(3, `fleet-smoke FRAMES-MISSING: cannot query ${framesDb}: ${String(cause).slice(0, 200)}`);
    }
    if (!report.frames_seen || report.frames_seen === 0) {
      report.reason = "frames-missing";
      return finish(3, `fleet-smoke FRAMES-MISSING: no observer frames for ${targetPk.slice(0, 8)}… since send`);
    }
    console.log(`fleet-smoke: ${report.frames_seen} observer frame(s) archived for the window`);
  }

  report.pass = true;
  report.reason = "pass";
  return finish(
    0,
    `fleet-smoke PASS: ${targetPk.slice(0, 8)}… replied in ${((report.reply_ms ?? 0) / 1000).toFixed(1)}s; journal clean${framesDb ? "; frames archived" : ""}`,
  );
}

await main();
