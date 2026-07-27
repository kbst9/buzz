import { AlertTriangle, ShieldCheck } from "lucide-react";
import * as React from "react";

import {
  useAgentHostsQuery,
  useBackendProvidersQuery,
} from "@/features/agents/hooks";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { acceptAgentHost, probeBackendProvider } from "@/shared/api/tauri";

import { ProviderConfigFields } from "./ProviderConfigFields";
import {
  emptyWhereToRunDraft,
  HOST_RUN_ON_PREFIX,
  hostPubkeyFromRunOn,
  isHostRunOn,
  type WhereToRunDraft,
} from "./whereToRunIntent";

/** Optional remote-backend selector. Buzz shared compute is an LLM provider, not a run destination. */
export function WhereToRunSection({
  draft,
  isPending,
  onDraftChange,
}: {
  draft: WhereToRunDraft;
  isPending: boolean;
  onDraftChange: (next: WhereToRunDraft) => void;
}) {
  const backendProviders = useBackendProvidersQuery().data ?? [];
  const hostsQuery = useAgentHostsQuery();
  const agentHosts = React.useMemo(
    () => hostsQuery.data ?? [],
    [hostsQuery.data],
  );
  const [probeError, setProbeError] = React.useState<string | null>(null);
  const [acceptError, setAcceptError] = React.useState<string | null>(null);
  const isHostMode = isHostRunOn(draft.runOn);
  const isProviderMode = draft.runOn !== "local" && !isHostMode;
  const selectedBackendProvider = React.useMemo(
    () =>
      backendProviders.find((provider) => provider.id === draft.runOn) ?? null,
    [backendProviders, draft.runOn],
  );

  // Keep the draft's host snapshot in sync with the discovery query so a
  // fresh acceptance (or a changed announcement) is reflected without
  // reselecting.
  React.useEffect(() => {
    if (!isHostMode) return;
    const hostPubkey = hostPubkeyFromRunOn(draft.runOn);
    const discovered =
      agentHosts.find(
        (host) => host.hostPubkey.toLowerCase() === hostPubkey.toLowerCase(),
      ) ?? null;
    if (discovered !== draft.selectedHost) {
      onDraftChange({
        ...draft,
        selectedHost: discovered,
        hostRuntime:
          draft.hostRuntime ||
          (discovered?.runtimes.length === 1 ? discovered.runtimes[0].id : ""),
      });
    }
  }, [agentHosts, draft, isHostMode, onDraftChange]);

  React.useEffect(() => {
    if (!isProviderMode || !selectedBackendProvider) {
      setProbeError(null);
      return;
    }
    let cancelled = false;
    setProbeError(null);
    void probeBackendProvider(selectedBackendProvider.binaryPath)
      .then((result) => {
        if (cancelled) return;
        const defaults: Record<string, string> = {};
        const properties =
          (result.config_schema as Record<string, unknown> | undefined)
            ?.properties ?? {};
        for (const [key, property] of Object.entries(properties) as [
          string,
          Record<string, unknown>,
        ][]) {
          if (property.default != null)
            defaults[key] = String(property.default);
        }
        onDraftChange({
          ...draft,
          probedProvider: result,
          providerConfig: defaults,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProbeError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [draft, isProviderMode, onDraftChange, selectedBackendProvider]);

  if (backendProviders.length === 0 && agentHosts.length === 0) return null;

  const selectedHost = draft.selectedHost;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="agent-run-on">
          Run on
        </label>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs"
          disabled={isPending}
          id="agent-run-on"
          onChange={(event) =>
            onDraftChange({
              ...emptyWhereToRunDraft,
              runOn: event.target.value,
            })
          }
          value={draft.runOn}
        >
          <option value="local">This computer</option>
          {agentHosts.map((host) => (
            <option
              key={host.hostPubkey}
              value={`${HOST_RUN_ON_PREFIX}${host.hostPubkey}`}
            >
              {host.label} (always-on host)
            </option>
          ))}
          {backendProviders.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.id}
            </option>
          ))}
        </select>
      </div>

      {isHostMode && selectedHost ? (
        <div className="space-y-4">
          {selectedHost.accepted ? (
            <div className="flex gap-3 rounded-2xl border border-input bg-muted/40 px-4 py-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <p className="text-sm text-muted-foreground">
                Accepted host{" "}
                <span className="font-mono font-medium">
                  {truncatePubkey(selectedHost.hostPubkey)}
                </span>
                . The agent runs there and keeps working when this computer is
                closed. Its key is generated on the host and never leaves it.
              </p>
            </div>
          ) : (
            <div className="space-y-3 rounded-2xl border border-warning/30 bg-warning-bg px-4 py-3">
              <div className="flex gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p className="text-sm text-warning">
                  First use of this host. Verify this pubkey matches the daemon
                  you operate (<code>buzz-agent-host --print-pubkey</code>),
                  then accept it:
                </p>
              </div>
              <p className="break-all font-mono text-2xs text-warning">
                {selectedHost.hostPubkey}
              </p>
              <button
                className="rounded-md border border-warning/40 px-3 py-1.5 text-sm font-medium text-warning hover:bg-warning/10"
                disabled={isPending}
                onClick={() => {
                  setAcceptError(null);
                  void acceptAgentHost(selectedHost.hostPubkey)
                    .then(() => hostsQuery.refetch())
                    .catch((error: unknown) =>
                      setAcceptError(
                        error instanceof Error ? error.message : String(error),
                      ),
                    );
                }}
                type="button"
              >
                Accept this host
              </button>
              {acceptError ? (
                <p className="text-sm text-destructive">{acceptError}</p>
              ) : null}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="agent-host-runtime">
              Runtime on {selectedHost.label}
            </label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs"
              disabled={isPending}
              id="agent-host-runtime"
              onChange={(event) =>
                onDraftChange({ ...draft, hostRuntime: event.target.value })
              }
              value={draft.hostRuntime}
            >
              <option value="">Choose a runtime…</option>
              {selectedHost.runtimes.map((runtime) => (
                <option key={runtime.id} value={runtime.id}>
                  {runtime.label}
                </option>
              ))}
            </select>
            <p className="text-2xs text-muted-foreground">
              {selectedHost.deployed}/{selectedHost.maxAgents} agents deployed
              on this host.
            </p>
          </div>
        </div>
      ) : null}

      {isHostMode && !selectedHost ? (
        <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          This host is no longer announced on the relay.
        </p>
      ) : null}

      {isProviderMode && selectedBackendProvider ? (
        <div className="space-y-4">
          <div className="flex gap-3 rounded-2xl border border-warning/30 bg-warning-bg px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-sm text-warning">
              This provider at{" "}
              <span className="font-mono font-medium">
                {selectedBackendProvider.binaryPath}
              </span>{" "}
              will receive your agent&apos;s private key. Only use providers
              from trusted sources.
            </p>
          </div>
          {probeError ? (
            <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              Could not probe provider: {probeError}
            </p>
          ) : null}
          {draft.probedProvider?.config_schema ? (
            <ProviderConfigFields
              config={draft.providerConfig}
              onChange={(providerConfig) =>
                onDraftChange({ ...draft, providerConfig })
              }
              schema={draft.probedProvider.config_schema}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
