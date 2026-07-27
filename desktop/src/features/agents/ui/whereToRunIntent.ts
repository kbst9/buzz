import type { BackendIntent } from "../lib/instanceInputForDefinition";
import type {
  AgentHostInfo,
  BackendProviderProbeResult,
} from "@/shared/api/types";
import { coerceConfigValues } from "./ProviderConfigFields";

/** `runOn` prefix marking a relay-discovered agent host (vs a provider id). */
export const HOST_RUN_ON_PREFIX = "host:";

/** Draft state of the optional remote-backend selector. */
export type WhereToRunDraft = {
  /** `"local"`, a provider id, or `host:<host_pubkey>`. */
  runOn: "local" | string;
  providerConfig: Record<string, string>;
  probedProvider: BackendProviderProbeResult | null;
  /** The selected host's announcement snapshot (host mode only). */
  selectedHost: AgentHostInfo | null;
  /** Runtime id chosen from the selected host's announcement. */
  hostRuntime: string;
};

export const emptyWhereToRunDraft: WhereToRunDraft = {
  runOn: "local",
  providerConfig: {},
  probedProvider: null,
  selectedHost: null,
  hostRuntime: "",
};

export function isHostRunOn(runOn: string): boolean {
  return runOn.startsWith(HOST_RUN_ON_PREFIX);
}

export function hostPubkeyFromRunOn(runOn: string): string {
  return runOn.slice(HOST_RUN_ON_PREFIX.length);
}

export function providerConfigComplete(draft: WhereToRunDraft): boolean {
  if (draft.runOn === "local") return true;
  if (isHostRunOn(draft.runOn)) {
    // Host mode: the host must be TOFU-accepted and a runtime chosen.
    return (
      draft.selectedHost?.accepted === true &&
      draft.hostRuntime.trim().length > 0
    );
  }
  if (!draft.probedProvider) return false;
  const schema = draft.probedProvider.config_schema as
    | Record<string, unknown>
    | undefined;
  const required: string[] = (schema?.required as string[] | undefined) ?? [];
  return required.every(
    (key) => (draft.providerConfig[key] ?? "").trim().length > 0,
  );
}

export function canSubmitWhereToRun(draft: WhereToRunDraft): boolean {
  return providerConfigComplete(draft);
}

export function resolveBackendIntent(
  draft: WhereToRunDraft,
): BackendIntent | null {
  if (draft.runOn === "local") return null;
  if (isHostRunOn(draft.runOn)) {
    return {
      type: "host",
      hostPubkey: hostPubkeyFromRunOn(draft.runOn),
      runtime: draft.hostRuntime,
    };
  }
  return {
    type: "provider",
    id: draft.runOn,
    config: coerceConfigValues(
      draft.providerConfig,
      draft.probedProvider?.config_schema,
    ),
  };
}
