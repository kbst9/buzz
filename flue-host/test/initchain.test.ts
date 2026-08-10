import { describe, expect, it } from "vitest";
import { InitChain } from "../src/sandbox/initchain.js";

/**
 * Failure-recovering init chain: the serialization seam the tier managers
 * (docker resources, srt manager, signing broker) run their process-global
 * init through. Pins the two properties the naive `pending.then(...)` chain
 * lacked — a rejected attempt is retried by the next call, and a down
 * dependency is not hammered inside the throttle window — plus the
 * serialization guarantee that must survive the rewrite.
 */

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("InitChain", () => {
  it("serializes work in enqueue order, no interleaving", async () => {
    const chain = new InitChain("test", 0);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = chain.run("a", async () => {
      order.push("a-start");
      await gate;
      order.push("a-end");
    });
    const second = chain.run("b", async () => {
      order.push("b");
    });
    await tick();
    expect(order).toEqual(["a-start"]); // b waits for a to settle
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("re-invokes the work after a failure instead of poisoning the chain", async () => {
    const chain = new InitChain("test", 0);
    let attempts = 0;
    const work = async (): Promise<void> => {
      attempts += 1;
      if (attempts === 1) throw new Error("dockerd blip");
    };
    // First caller sees the real error…
    await expect(chain.run("k", work)).rejects.toThrow("dockerd blip");
    // …and the next call re-attempts and succeeds — no process restart.
    await expect(chain.run("k", work)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    // Subsequent success runs the work again (idempotence is the work's job).
    await chain.run("k", work);
    expect(attempts).toBe(3);
  });

  it("keeps serving work after a failed link (other keys unaffected)", async () => {
    const chain = new InitChain("test", 0);
    await expect(chain.run("bad", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    let ran = false;
    await chain.run("good", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("throttles re-attempts within the window, rethrowing the recorded error", async () => {
    const chain = new InitChain("test", 60_000);
    let attempts = 0;
    const work = async (): Promise<void> => {
      attempts += 1;
      throw new Error(`attempt ${attempts}`);
    };
    await expect(chain.run("k", work)).rejects.toThrow("attempt 1");
    // Within the window: the caller still gets the real underlying error,
    // but the work is NOT re-invoked (no hammering a down dependency).
    await expect(chain.run("k", work)).rejects.toThrow("attempt 1");
    await expect(chain.run("k", work)).rejects.toThrow("attempt 1");
    expect(attempts).toBe(1);
  });

  it("throttle is per key", async () => {
    const chain = new InitChain("test", 60_000);
    await expect(chain.run("a", async () => {
      throw new Error("a down");
    })).rejects.toThrow("a down");
    let ran = false;
    await chain.run("b", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("retries immediately once the window elapses", async () => {
    const chain = new InitChain("test", 30);
    let attempts = 0;
    const work = async (): Promise<void> => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    };
    await expect(chain.run("k", work)).rejects.toThrow("transient");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(chain.run("k", work)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("clearFailures lifts the throttle (test-reset hook)", async () => {
    const chain = new InitChain("test", 60_000);
    let attempts = 0;
    const work = async (): Promise<void> => {
      attempts += 1;
      if (attempts === 1) throw new Error("once");
    };
    await expect(chain.run("k", work)).rejects.toThrow("once");
    chain.clearFailures();
    await expect(chain.run("k", work)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("idle settles after failures without throwing", async () => {
    const chain = new InitChain("test", 0);
    void chain.run("k", async () => {
      throw new Error("discarded");
    });
    await expect(chain.idle()).resolves.toBeUndefined();
  });

  it("a fire-and-forget failed run does not crash the process", async () => {
    // Session create warms init with `void ensureX(...)`; a rejection with
    // no awaiter must be pre-handled inside run(). If it weren't, vitest
    // would report an unhandled rejection for this test.
    const chain = new InitChain("test", 0);
    void chain.run("k", async () => {
      throw new Error("nobody awaits this");
    });
    await chain.idle();
    await tick();
  });
});
