import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle } from "lucide-react";
import * as React from "react";

import {
  useHuddleAgentCandidates,
  type HuddleAgentCandidate,
} from "@/features/huddle/useHuddleAgentCandidates";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";

type AgentAddResult = {
  ephemeral_added: boolean;
  parent_added: boolean;
  parent_error: string | null;
};

type AddAgentDialogProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (pubkey: string) => Promise<AgentAddResult>;
  currentAgentPubkeys: string[];
};

export function AddAgentDialog({
  open,
  onClose,
  onAdd,
  currentAgentPubkeys,
}: AddAgentDialogProps) {
  // Managed agents (stopped ones auto-start on add) plus connected community
  // agents — the add path just publishes kind:9000 role=bot, so any verified
  // agent qualifies.
  const { candidates, isLoading, isError } = useHuddleAgentCandidates();
  const [adding, setAdding] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [warning, setWarning] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setAdding(null);
    setError(null);
    setWarning(null);
  }, [open]);

  // Only offer agents that aren't already in the huddle.
  const currentPubkeys = React.useMemo(
    () => new Set(currentAgentPubkeys.map((pubkey) => normalizePubkey(pubkey))),
    [currentAgentPubkeys],
  );
  const availableAgents = candidates.filter(
    (candidate) => !currentPubkeys.has(candidate.pubkey),
  );

  const displayError = error ?? (isError ? "Could not load agents." : null);

  async function handleAdd(candidate: HuddleAgentCandidate) {
    if (adding) return;
    setAdding(candidate.pubkey);
    setError(null);
    setWarning(null);
    let startedForAdd = false;
    try {
      // Connected (standalone) agents run on their own hosts — the desktop
      // cannot start them; the kind:9000 add is the whole operation. Managed
      // agents follow the start-before/after-add flow.
      const isManaged = candidate.source === "managed";
      const isLocal = candidate.backend?.type === "local";
      const needsStart =
        isManaged &&
        (isLocal
          ? candidate.status !== "running"
          : candidate.status !== "deployed");
      if (needsStart && isLocal) {
        await invoke("start_managed_agent", { pubkey: candidate.pubkey });
        startedForAdd = true;
      }
      const result = await onAdd(candidate.pubkey);
      if (needsStart && !isLocal) {
        try {
          await invoke("start_managed_agent", { pubkey: candidate.pubkey });
        } catch (startError: unknown) {
          const msg =
            startError instanceof Error
              ? startError.message
              : String(startError);
          setWarning(`Added to huddle, but could not start agent: ${msg}`);
          console.error("Failed to start agent after huddle add:", startError);
          return;
        }
      }
      if (result.parent_error) {
        // Agent was added to the ephemeral channel but parent channel add failed.
        // Show as a warning — don't close the dialog so the user can see it.
        setWarning(
          `Added to huddle, but parent channel failed: ${result.parent_error}`,
        );
      } else {
        onClose();
      }
    } catch (e: unknown) {
      if (startedForAdd) {
        try {
          await invoke("stop_managed_agent", { pubkey: candidate.pubkey });
        } catch (rollbackError: unknown) {
          console.error(
            "Failed to stop agent after huddle add failed:",
            rollbackError,
          );
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Failed to add agent: ${msg}`);
      console.error("Failed to add agent to huddle:", e);
    } finally {
      setAdding(null);
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={open}
    >
      <ChooserDialogContent
        className="max-w-xl"
        data-testid="add-huddle-agent-dialog"
        headerSubtitle="Choose an agent to join this huddle."
        scrollAreaClassName="space-y-5"
        title="Add agents"
      >
        {displayError ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {displayError}
          </p>
        ) : null}

        {warning ? (
          <p className="rounded-lg border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning">
            {warning}
          </p>
        ) : null}

        {isLoading ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Loading agents…
          </p>
        ) : availableAgents.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {candidates.length > 0
              ? "All available agents are already in this huddle."
              : "No agents found."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {availableAgents.map((candidate) => {
              const isAdding = adding === candidate.pubkey;
              return (
                <li key={candidate.pubkey}>
                  <button
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    disabled={adding !== null}
                    onClick={() => void handleAdd(candidate)}
                    type="button"
                  >
                    <ProfileAvatar
                      avatarUrl={candidate.avatarUrl}
                      className="h-9 w-9 shrink-0 text-xs"
                      label={candidate.name}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {candidate.name}
                    </span>
                    {candidate.source === "connected" && !isAdding ? (
                      <span
                        aria-label={candidate.online ? "online" : "offline"}
                        className={cn(
                          "h-2 w-2 shrink-0 rounded-full",
                          candidate.online
                            ? "bg-emerald-500"
                            : "bg-muted-foreground/40",
                        )}
                        role="img"
                      />
                    ) : null}
                    {isAdding ? (
                      <LoaderCircle
                        aria-label={`Adding ${candidate.name}`}
                        className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ChooserDialogContent>
    </Dialog>
  );
}

export type { AgentAddResult };
