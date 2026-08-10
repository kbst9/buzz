import { log } from "../log.js";

/**
 * Serialized init chain that recovers from failure. The tier managers
 * (docker resources, srt manager, signing broker) each serialize their
 * process-global init through one promise chain; the naive
 * `pending = pending.then(work)` shape poisons the chain on the first
 * rejection — every later call chains onto the rejected promise, re-throws
 * the same stale error forever, and (because that surfaces to buzz-acp as an
 * application-class error, not a crash) the agent stays bricked until a
 * manual restart. One dockerd blip, image-pull failure, or bind error must
 * not require operator intervention.
 *
 * `run()` keeps the serialization guarantee — work bodies never interleave,
 * enqueue order is execution order — but chains onto the previous link's
 * settlement rather than its success, so a failed attempt is retried by the
 * next call. A per-key throttle keeps a truly-down dependency from being
 * hammered by parallel tool calls: within `retryDelayMs` of a failed
 * attempt, calls for that key re-throw the recorded error instead of
 * re-attempting (the caller still sees the real underlying failure).
 */
export class InitChain {
  #tail: Promise<void> = Promise.resolve();
  readonly #lastFailure = new Map<string, { at: number; error: unknown }>();

  constructor(
    private readonly label: string,
    private readonly retryDelayMs: number = 3_000,
  ) {}

  /**
   * Enqueue `work` after everything already enqueued, regardless of whether
   * that earlier work failed. Returns this call's own settlement: callers
   * that await see their attempt's success or real error.
   */
  run(key: string, work: () => Promise<void>): Promise<void> {
    const attempt = async (): Promise<void> => {
      const failure = this.#lastFailure.get(key);
      if (failure !== undefined && Date.now() - failure.at < this.retryDelayMs) {
        throw failure.error;
      }
      try {
        await work();
      } catch (error) {
        // Recorded at attempt time (throttled re-throws keep the original
        // timestamp, so steady polling can't extend the window forever).
        this.#lastFailure.set(key, { at: Date.now(), error });
        log.warn(`${this.label} init failed; retrying on a later call`, {
          key,
          error: String(error),
          retryDelayMs: this.retryDelayMs,
        });
        throw error;
      }
      if (failure !== undefined) {
        this.#lastFailure.delete(key);
        log.info(`${this.label} init recovered`, { key });
      }
    };
    const link = this.#tail.then(attempt, attempt);
    // Session create fire-and-forgets init warmup (`void ensureX(...)`); a
    // discarded rejection must not become an unhandledRejection crash. The
    // caller that awaits `link` still receives the rejection.
    link.catch(() => {});
    this.#tail = link;
    return link;
  }

  /** Settlement of everything enqueued so far, failures swallowed (teardown). */
  async idle(): Promise<void> {
    await this.#tail.catch(() => {});
  }

  /** Test-only: forget recorded failures so the next run retries immediately. */
  clearFailures(): void {
    this.#lastFailure.clear();
  }
}
