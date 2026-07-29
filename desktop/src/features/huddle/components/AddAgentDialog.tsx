import { Bot } from "lucide-react";
import * as React from "react";

import { useHuddleAgentCandidates } from "@/features/huddle/useHuddleAgentCandidates";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

type AgentAddResult = {
  ephemeral_added: boolean;
  parent_added: boolean;
  parent_error: string | null;
};

type AddAgentDialogProps = {
  onClose: () => void;
  onAdd: (pubkey: string) => Promise<AgentAddResult>;
  currentAgentPubkeys: string[];
};

export function AddAgentDialog({
  onClose,
  onAdd,
  currentAgentPubkeys,
}: AddAgentDialogProps) {
  // Running managed agents plus connected community agents — the add path
  // just publishes kind:9000 role=bot, so any verified agent qualifies.
  const { candidates, isLoading, isError } = useHuddleAgentCandidates();
  const [adding, setAdding] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [warning, setWarning] = React.useState<string | null>(null);

  // Only offer agents that aren't already in the huddle.
  const currentPubkeys = React.useMemo(
    () => new Set(currentAgentPubkeys.map((pubkey) => normalizePubkey(pubkey))),
    [currentAgentPubkeys],
  );
  const availableAgents = candidates.filter(
    (candidate) => !currentPubkeys.has(candidate.pubkey),
  );

  const displayError = error ?? (isError ? "Could not load agents." : null);

  async function handleAdd(pubkey: string) {
    if (adding) return;
    setAdding(pubkey);
    setError(null);
    setWarning(null);
    try {
      const result = await onAdd(pubkey);
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
      open
    >
      <DialogContent className="flex max-h-[60vh] max-w-sm flex-col gap-0 p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Add Agent to Huddle</DialogTitle>
          <DialogDescription>
            Select an agent to join the huddle.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {displayError && (
            <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {displayError}
            </p>
          )}

          {warning && (
            <div className="mb-3 flex items-start justify-between gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              <span>{warning}</span>
              <button
                className="shrink-0 font-medium underline-offset-2 hover:underline"
                onClick={onClose}
                type="button"
              >
                Dismiss
              </button>
            </div>
          )}

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
              {availableAgents.map((candidate) => (
                <li key={candidate.pubkey}>
                  <button
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    disabled={adding === candidate.pubkey}
                    onClick={() => void handleAdd(candidate.pubkey)}
                    type="button"
                  >
                    <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate font-medium">
                      {candidate.name}
                    </span>
                    {candidate.source === "connected" && (
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
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {candidate.source === "managed" ? "running" : "connected"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t px-6 py-4">
          <Button className="w-full" onClick={onClose} variant="outline">
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type { AgentAddResult };
