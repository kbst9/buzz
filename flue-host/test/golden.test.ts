import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEngine } from "../src/engine/types.js";
import { createFlueEngine } from "../src/engine/flue.js";
import { TestClient } from "./helpers.js";

/**
 * The golden transcript: the sequence buzz-acp drives on a real turn —
 * initialize → session/new (cwd + systemPrompt + mcpServers) →
 * session/prompt → streamed session/update notifications → stopReason —
 * served by the REAL Flue runtime with a scripted model. The tool call is
 * not mocked: the faux model requests `bash`, and Flue's local sandbox
 * actually executes it in the session cwd with the forwarded env.
 */
describe("golden transcript against the real Flue runtime", () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "buzz-test" }] });
  let workspace: string;
  let engine: AgentEngine;
  let client: TestClient;

  beforeAll(async () => {
    process.env["BUZZ_FLUE_MODEL"] = "faux/buzz-test";
    workspace = await mkdtemp(join(tmpdir(), "flue-acp-golden-"));
    engine = await createFlueEngine({
      model: "faux/buzz-test",
      providers: [faux.provider],
    });
    client = new TestClient(engine, { version: "golden" });
  });

  afterAll(async () => {
    client.close();
    await client.done;
    await engine.stop();
    await rm(workspace, { recursive: true, force: true });
  });

  it("plays one full turn: text, a real sandboxed tool call, stopReason", async () => {
    const initId = client.request("initialize", {
      protocolVersion: 2,
      clientCapabilities: { auth: { terminal: true } },
      clientInfo: { name: "buzz-acp", version: "test" },
    });
    expect((await client.response(initId))["result"]).toMatchObject({ protocolVersion: 2 });

    const newId = client.request("session/new", {
      cwd: workspace,
      systemPrompt: "[System]\nYou are Golden, a test agent.",
      mcpServers: [
        {
          name: "buzz-dev-mcp",
          command: "/usr/local/bin/buzz-dev-mcp",
          args: [],
          env: [{ name: "BUZZ_RELAY_URL", value: "wss://golden.test" }],
        },
      ],
      _meta: { sessionTitle: "Golden · #general" },
    });
    const newResult = (await client.response(newId))["result"] as { sessionId: string };
    expect(newResult.sessionId).toMatch(/^ses_/);
    expect(newResult).toMatchObject({ models: { currentModelId: "faux/buzz-test" } });

    // Turn script: call bash (proving sandbox exec + env forwarding), then conclude.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: 'printf "relay=%s cwd=%s" "$BUZZ_RELAY_URL" "$PWD"' })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("The sandbox answered.", { stopReason: "stop" }),
    ]);

    const promptId = client.request("session/prompt", {
      sessionId: newResult.sessionId,
      prompt: [{ type: "text", text: "[Buzz @mention]\nMessage: run the check" }],
    });
    const response = await client.response(promptId);
    expect(response["result"]).toEqual({ stopReason: "end_turn" });

    const updates = client.updates();
    const toolCall = updates.find((update) => update["sessionUpdate"] === "tool_call");
    expect(toolCall).toMatchObject({ title: "bash", kind: "other", status: "pending" });

    const completed = updates.find(
      (update) => update["sessionUpdate"] === "tool_call_update" && update["status"] === "completed",
    );
    expect(completed).toBeDefined();
    const outputText = JSON.stringify(completed);
    expect(outputText).toContain("relay=wss://golden.test");
    expect(outputText).toContain(workspace);

    const text = updates
      .filter((update) => update["sessionUpdate"] === "agent_message_chunk")
      .map((update) => (update["content"] as { text?: string } | undefined)?.text ?? "")
      .join("");
    expect(text).toContain("The sandbox answered.");

    const order = updates.map((update) => update["sessionUpdate"]);
    expect(order.indexOf("tool_call")).toBeLessThan(order.lastIndexOf("tool_call_update"));
  });

  it("keeps the session across turns (long-lived sessions, one instance per session)", async () => {
    faux.setResponses([fauxAssistantMessage("Second turn reply.", { stopReason: "stop" })]);
    const sessionId = ((await client.waitFor((frame) => {
      const result = frame["result"] as { sessionId?: string } | undefined;
      return typeof result?.sessionId === "string";
    })) as { result: { sessionId: string } }).result.sessionId;

    const promptId = client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "again" }],
    });
    expect((await client.response(promptId))["result"]).toEqual({ stopReason: "end_turn" });
  });
});
