import { describe, expect, it } from "vitest";
import type { SessionUpdateBody, StopReason } from "../src/acp/protocol.js";
import { agentMessageChunk } from "../src/acp/protocol.js";
import type { AgentEngine, SessionSeed } from "../src/engine/types.js";
import { TurnFailedError } from "../src/engine/types.js";
import { TestClient } from "./helpers.js";

/** Deterministic engine for protocol-layer conformance tests. */
function stubEngine(overrides: Partial<AgentEngine> = {}): AgentEngine & { seeds: SessionSeed[]; cancelled: string[] } {
  const seeds: SessionSeed[] = [];
  const cancelled: string[] = [];
  return {
    seeds,
    cancelled,
    modelId: "faux/stub",
    newSession(seed) {
      seeds.push(seed);
      return Promise.resolve(`ses_${seeds.length}`);
    },
    hasSession(sessionId) {
      return sessionId.startsWith("ses_");
    },
    prompt(_sessionId, text, onUpdate) {
      onUpdate(agentMessageChunk(`echo: ${text}`));
      return Promise.resolve<StopReason>("end_turn");
    },
    cancel(sessionId) {
      cancelled.push(sessionId);
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
    ...overrides,
  };
}

const INITIALIZE_PARAMS = {
  protocolVersion: 2,
  clientCapabilities: { auth: { terminal: true } },
  clientInfo: { name: "buzz-acp", version: "test" },
};

describe("AcpServer protocol conformance", () => {
  it("negotiates initialize the way buzz-agent does", async () => {
    const client = new TestClient(stubEngine(), { version: "1.2.3" });
    const id = client.request("initialize", INITIALIZE_PARAMS);
    const response = await client.response(id);
    expect(response["result"]).toMatchObject({
      protocolVersion: 2,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "flue-acp", version: "1.2.3" },
    });
    client.close();
    await client.done;
  });

  it("answers unknown methods with -32601 and preserves string ids", async () => {
    const client = new TestClient(stubEngine());
    // The steering trap: a success reply here would make buzz-acp drop a user message.
    client.send({ jsonrpc: "2.0", id: "steer-1", method: "_session/steering", params: {} });
    const response = await client.waitFor((frame) => frame["id"] === "steer-1");
    expect(response["error"]).toMatchObject({ code: -32601 });
    expect((response["error"] as { message: string }).message).toContain("_session/steering");
    client.close();
    await client.done;
  });

  it("drops unknown notifications silently", async () => {
    const client = new TestClient(stubEngine());
    client.notification("_goose/unstable/whatever", {});
    const id = client.request("initialize", INITIALIZE_PARAMS);
    await client.response(id);
    expect(client.observed()).toHaveLength(1);
    client.close();
    await client.done;
  });

  it("rejects a relative cwd with -32602", async () => {
    const client = new TestClient(stubEngine());
    const id = client.request("session/new", { cwd: "relative/path", mcpServers: [] });
    const response = await client.response(id);
    expect(response["error"]).toMatchObject({ code: -32602 });
    client.close();
    await client.done;
  });

  it("seeds sessions from cwd, systemPrompt, and mcpServers env", async () => {
    const engine = stubEngine();
    const client = new TestClient(engine);
    const id = client.request("session/new", {
      cwd: "/tmp/nest",
      systemPrompt: "[System]\nBe excellent.",
      mcpServers: [
        {
          name: "buzz-dev-mcp",
          command: "/usr/local/bin/buzz-dev-mcp",
          args: [],
          env: [{ name: "BUZZ_RELAY_URL", value: "wss://unit.test" }],
        },
      ],
      _meta: { sessionTitle: "Eva · #general" },
    });
    const response = await client.response(id);
    expect(response["result"]).toMatchObject({
      sessionId: "ses_1",
      models: { currentModelId: "faux/stub" },
    });
    expect(engine.seeds[0]).toMatchObject({
      cwd: "/tmp/nest",
      systemPrompt: "[System]\nBe excellent.",
      env: { BUZZ_RELAY_URL: "wss://unit.test" },
    });
    client.close();
    await client.done;
  });

  it("streams updates then answers the prompt with its stopReason", async () => {
    const client = new TestClient(stubEngine());
    const id = client.request("session/prompt", {
      sessionId: "ses_1",
      prompt: [{ type: "text", text: "hello" }, { type: "text", text: "world" }],
    });
    const response = await client.response(id);
    expect(response["result"]).toEqual({ stopReason: "end_turn" });
    expect(client.updates()).toContainEqual(expect.objectContaining({ sessionUpdate: "agent_message_chunk" }));
    const updateIndex = client.observed().findIndex((f) => (f as { method?: string }).method === "session/update");
    const responseIndex = client.observed().findIndex((f) => (f as { id?: unknown }).id === id);
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeLessThan(responseIndex);
    client.close();
    await client.done;
  });

  it("rejects prompts for unknown sessions and prompts without text", async () => {
    const client = new TestClient(stubEngine());
    const unknown = client.request("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "x" }] });
    expect((await client.response(unknown))["error"]).toMatchObject({ code: -32602 });
    const empty = client.request("session/prompt", { sessionId: "ses_1", prompt: [{ type: "image" }] });
    expect((await client.response(empty))["error"]).toMatchObject({ code: -32602 });
    client.close();
    await client.done;
  });

  it("maps a failed turn to a -32000 error carrying the cause message", async () => {
    const engine = stubEngine({
      prompt: () => Promise.reject(new TurnFailedError("API Error: 401 Unauthorized")),
    });
    const client = new TestClient(engine);
    const id = client.request("session/prompt", { sessionId: "ses_1", prompt: [{ type: "text", text: "x" }] });
    const response = await client.response(id);
    expect(response["error"]).toMatchObject({ code: -32000, message: "API Error: 401 Unauthorized" });
    client.close();
    await client.done;
  });

  it("cancels: notification reaches the engine; request form gets a null result; in-flight prompt settles cancelled", async () => {
    let release: ((reason: StopReason) => void) | undefined;
    const engine = stubEngine({
      prompt: () =>
        new Promise<StopReason>((resolve) => {
          release = resolve;
        }),
      cancel(sessionId) {
        engine.cancelled.push(sessionId);
        release?.("cancelled");
        return Promise.resolve();
      },
    });
    const client = new TestClient(engine);
    const promptId = client.request("session/prompt", { sessionId: "ses_9", prompt: [{ type: "text", text: "long" }] });
    client.notification("session/cancel", { sessionId: "ses_9" });
    const response = await client.response(promptId);
    expect(response["result"]).toEqual({ stopReason: "cancelled" });
    expect(engine.cancelled).toEqual(["ses_9"]);

    const cancelRequest = client.request("session/cancel", { sessionId: "ses_9" });
    expect((await client.response(cancelRequest))["result"]).toBeNull();
    client.close();
    await client.done;
  });

  it("emits keepalives while a turn is in flight", async () => {
    let release: ((reason: StopReason) => void) | undefined;
    const engine = stubEngine({
      prompt: () =>
        new Promise<StopReason>((resolve) => {
          release = resolve;
        }),
    });
    const client = new TestClient(engine, { keepaliveMs: 20 });
    const id = client.request("session/prompt", { sessionId: "ses_1", prompt: [{ type: "text", text: "slow" }] });
    await client.waitFor((frame) => {
      const update = (frame as { params?: { update?: SessionUpdateBody } }).params?.update;
      return update?.sessionUpdate === "keepalive";
    });
    release?.("end_turn");
    await client.response(id);
    client.close();
    await client.done;
  });
});
