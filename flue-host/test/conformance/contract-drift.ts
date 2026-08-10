import type { FileStat, SandboxFactory, SessionEnv, ShellResult } from "@flue/runtime";

/**
 * Contract-drift canary (AGENT_OS_M0.md invariant 4). Compile-time only:
 * these type-level assertions pin the exact `@flue/runtime` sandbox surface
 * the tier adapters depend on. A Flue bump that moves any of it fails
 * `tsc --noEmit` inside `just flue-check` loudly — before any runtime
 * symptom. On a deliberate contract change, re-pin here consciously as part
 * of the bump commit.
 *
 * The pins are method-by-method (what we depend on), not `keyof`-exact:
 * additive surface on Flue's side must not fail the canary; changed or
 * removed surface must.
 */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ── ShellResult: the tool-facing exec result shape ─────────────────────────
export type PinShellResult = Expect<
  Equal<ShellResult, { stdout: string; stderr: string; exitCode: number }>
>;

// ── FileStat: what stat() reports (optional fields must stay optional) ─────
export type PinFileStat = Expect<
  Equal<
    FileStat,
    {
      isFile: boolean;
      isDirectory: boolean;
      isSymbolicLink?: boolean;
      size?: number;
      mtime?: Date;
    }
  >
>;

// ── SessionEnv.exec: command + the four options tiers translate ────────────
export type PinExec = Expect<
  Equal<
    SessionEnv["exec"],
    (
      command: string,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
        signal?: AbortSignal;
      },
    ) => Promise<ShellResult>
  >
>;

// ── SessionEnv file verbs (the ~10-method surface) ─────────────────────────
export type PinReadFile = Expect<Equal<SessionEnv["readFile"], (path: string) => Promise<string>>>;
export type PinReadFileBuffer = Expect<
  Equal<SessionEnv["readFileBuffer"], (path: string) => Promise<Uint8Array>>
>;
export type PinWriteFile = Expect<
  Equal<SessionEnv["writeFile"], (path: string, content: string | Uint8Array) => Promise<void>>
>;
export type PinStat = Expect<Equal<SessionEnv["stat"], (path: string) => Promise<FileStat>>>;
export type PinReaddir = Expect<Equal<SessionEnv["readdir"], (path: string) => Promise<string[]>>>;
export type PinExists = Expect<Equal<SessionEnv["exists"], (path: string) => Promise<boolean>>>;
export type PinMkdir = Expect<
  Equal<SessionEnv["mkdir"], (path: string, options?: { recursive?: boolean }) => Promise<void>>
>;
export type PinRm = Expect<
  Equal<
    SessionEnv["rm"],
    (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>
  >
>;
export type PinCwd = Expect<Equal<SessionEnv["cwd"], string>>;
export type PinResolvePath = Expect<Equal<SessionEnv["resolvePath"], (p: string) => string>>;

// ── SandboxFactory: the seam every tier implements ─────────────────────────
// Flue 2.0.3 renamed the primary method createSessionEnv → createSandbox
// (createSessionEnv kept as a deprecated fallback). Our adapters publish
// createSandbox (+ the alias); pin the current method by name.
export type PinCreateSandbox = Expect<
  Equal<Parameters<SandboxFactory["createSandbox"]>, [{ id: string }]>
>;
export type PinCreateSandboxReturn = Expect<
  Equal<ReturnType<SandboxFactory["createSandbox"]>, Promise<SessionEnv>>
>;

/**
 * Contract version bumped with the Flue 2.0.1 → 2.0.3 sandbox-surface change
 * (createSessionEnv → createSandbox; SessionEnv is now an alias of Sandbox).
 */
export const CONTRACT_DRIFT_CANARY = "flue-runtime-sandbox-contract-v2";
