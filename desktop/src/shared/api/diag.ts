import { invokeTauri } from "@/shared/api/tauri";

/**
 * Temporary diagnostics tap (feat/observer-diag): forwards gate-level
 * observer diagnostics to the tauri process stdout, where a terminal
 * launch captures them. Fire-and-forget; never throws into callers.
 */
export function diag(message: string): void {
  void invokeTauri("diag_log", { message }).catch(() => {});
}
