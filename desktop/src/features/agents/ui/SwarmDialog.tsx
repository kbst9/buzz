import { Plus, X } from "lucide-react";
import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";

import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import {
  type SwarmDefinition,
  serializeSwarmContent,
} from "@/features/agents/lib/swarmDefinition";
import {
  appendEmptyMemberRow,
  combineSwarmAgentOptions,
  defaultSwarmName,
  memberLeaderWarning,
  memberOptionsForRow,
  memberRowsFromDefinition,
  removeMemberRow,
  rowsToMembers,
  type SwarmMemberRow,
  updateMemberRow,
  validateSwarmDraft,
} from "@/features/agents/lib/swarmDialogState";
import { useVerifiedAgents } from "@/features/agents/lib/useVerifiedAgents";
import { AgentDropdownSelect } from "@/features/agents/ui/agentConfigControls";
import {
  PERSONA_FIELD_CONTROL_CLASS,
  PERSONA_FIELD_SHELL_CLASS,
} from "@/features/agents/ui/agentConfigOptions";
import { useIdentityQuery } from "@/shared/api/hooks";
import { publishSwarmDefinition } from "@/shared/api/swarms";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey } from "@/shared/lib/pubkey";

export type SwarmDialogState =
  | { mode: "create" }
  | { mode: "edit"; swarm: SwarmDefinition };

const MEMBER_DESCRIPTION_PLACEHOLDER =
  "This agent should write specifications/generate images/execute small code changes/do bug fixes";

/**
 * Create/edit dialog for a SWARM — an owner-authored delegation group with a
 * required leader (docs/swarms.md §6). Save publishes the kind:30178
 * definition owner-signed via `publishSwarmDefinition`; the leader picks it
 * up at its next session, so this works while the leader is offline.
 *
 * Mount conditionally (`state` non-null) with a `key` per swarm so the form
 * state seeds fresh on every open.
 */
export function SwarmDialog({
  state,
  onOpenChange,
}: {
  state: SwarmDialogState;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const identityQuery = useIdentityQuery();
  const me = identityQuery.data?.pubkey ?? null;
  const managedAgentsQuery = useManagedAgentsQuery();
  const relayAgentsQuery = useRelayAgentsQuery();
  // Leader/member options span ANY agent: managed identities plus the
  // community's verified (connected) agents from the shared enumeration.
  const verifiedAgents = useVerifiedAgents();

  const editingSwarm = state.mode === "edit" ? state.swarm : null;
  const [name, setName] = React.useState(editingSwarm?.name ?? "");
  const [leaderPubkey, setLeaderPubkey] = React.useState(
    editingSwarm ? normalizePubkey(editingSwarm.leaderPubkey) : "",
  );
  const [instructions, setInstructions] = React.useState(
    editingSwarm?.instructions ?? "",
  );
  const [{ rows }, setRowState] = React.useState(() =>
    memberRowsFromDefinition(editingSwarm?.members ?? []),
  );
  const [reportBack, setReportBack] = React.useState(
    editingSwarm?.reportBack ?? false,
  );
  const [evaluationCriteria, setEvaluationCriteria] = React.useState(
    editingSwarm?.evaluationCriteria ?? "",
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const agentOptions = React.useMemo(
    () =>
      combineSwarmAgentOptions(
        managedAgentsQuery.data ?? [],
        verifiedAgents.agents,
      ),
    [managedAgentsQuery.data, verifiedAgents.agents],
  );
  const leaderOption = agentOptions.find(
    (option) => option.pubkey === leaderPubkey,
  );
  const directoryAgentsByPubkey = React.useMemo(
    () =>
      new Map(
        (relayAgentsQuery.data ?? []).map((agent) => [
          normalizePubkey(agent.pubkey),
          agent,
        ]),
      ),
    [relayAgentsQuery.data],
  );

  const handleLeaderChange = (nextLeader: string) => {
    setLeaderPubkey(nextLeader);
    // A member row holding the new leader would violate the leader-excluded
    // rule — clear its pick (the description survives for the next pick).
    setRowState((current) => ({
      ...current,
      rows: current.rows.map((row) =>
        row.pubkey === nextLeader ? { ...row, pubkey: "" } : row,
      ),
    }));
  };

  const handleSave = async () => {
    const validationError = validateSwarmDraft({ leaderPubkey, rows });
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }
    setErrorMessage(null);
    setIsSaving(true);
    try {
      await publishSwarmDefinition({
        swarmId: editingSwarm?.id ?? crypto.randomUUID(),
        contentJson: serializeSwarmContent({
          name: name.trim(),
          leaderPubkey,
          instructions,
          members: rowsToMembers(rows),
          reportBack,
          evaluationCriteria,
        }),
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message
          ? error.message
          : "Publishing the swarm failed — check the relay connection.",
      );
      setIsSaving(false);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["swarm-definitions"] });
    setIsSaving(false);
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <ChooserDialogContent
        className="max-w-2xl border-0"
        contentClassName="space-y-6 pt-1"
        data-testid="swarm-dialog"
        headerClassName="pb-1"
        title={state.mode === "edit" ? "Edit Swarm" : "Create Swarm"}
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-xs text-destructive" role="status">
              {errorMessage}
            </span>
            <div className="flex items-center gap-2">
              <Button
                disabled={isSaving}
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                data-testid="swarm-dialog-save"
                disabled={isSaving}
                onClick={() => void handleSave()}
                type="button"
              >
                {isSaving
                  ? "Saving..."
                  : state.mode === "edit"
                    ? "Save changes"
                    : "Create swarm"}
              </Button>
            </div>
          </div>
        }
      >
        <p className="text-sm text-muted-foreground">
          Group agents together for quick deployment and delegation
        </p>

        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="swarm-name"
          >
            Name
          </label>
          <div
            className={cn(
              "flex min-h-11 items-center px-3",
              PERSONA_FIELD_SHELL_CLASS,
            )}
          >
            <Input
              autoCorrect="off"
              className={cn(
                "h-8 px-0 py-0 leading-6",
                PERSONA_FIELD_CONTROL_CLASS,
              )}
              data-testid="swarm-name"
              disabled={isSaving}
              id="swarm-name"
              onChange={(event) => setName(event.target.value)}
              placeholder={
                leaderOption
                  ? defaultSwarmName(leaderOption.label)
                  : "Swarm name"
              }
              value={name}
            />
          </div>
        </div>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Leader</h3>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="swarm-leader"
            >
              Leader
            </label>
            <p className="text-xs text-muted-foreground">
              The leader delegates tasks to members of the swarm
            </p>
            <AgentDropdownSelect
              ariaRequired
              disabled={isSaving}
              emptyOptionsLabel="No agents available"
              id="swarm-leader"
              onValueChange={handleLeaderChange}
              options={agentOptions.map((option) => ({
                label: option.label,
                value: option.pubkey,
              }))}
              placeholder="Select leader"
              testId="swarm-leader"
              value={leaderPubkey}
            />
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="swarm-instructions"
            >
              Instructions
            </label>
            <div className={cn("px-3 py-2", PERSONA_FIELD_SHELL_CLASS)}>
              <Textarea
                className={cn(
                  "min-h-24 resize-none px-0 py-0",
                  PERSONA_FIELD_CONTROL_CLASS,
                )}
                data-testid="swarm-instructions"
                disabled={isSaving}
                id="swarm-instructions"
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="How the leader should run this swarm"
                value={instructions}
              />
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Members</h3>
            <p className="text-xs text-muted-foreground">
              Select agents to include in this swarm.
            </p>
          </div>
          <div className="space-y-2" data-testid="swarm-member-rows">
            {rows.map((row) => (
              <SwarmMemberRowFields
                key={row.key}
                disabled={isSaving}
                onDescriptionChange={(description) =>
                  setRowState((current) => ({
                    ...current,
                    rows: updateMemberRow(current.rows, row.key, {
                      description,
                    }),
                  }))
                }
                onPubkeyChange={(pubkey) =>
                  setRowState((current) => ({
                    ...current,
                    rows: updateMemberRow(current.rows, row.key, { pubkey }),
                  }))
                }
                onRemove={() =>
                  setRowState((current) =>
                    removeMemberRow(current.rows, row.key, current.nextKey),
                  )
                }
                options={memberOptionsForRow(agentOptions, {
                  leaderPubkey,
                  rows,
                  rowKey: row.key,
                })}
                row={row}
                warning={memberLeaderWarning({
                  directoryEntry:
                    row.pubkey !== ""
                      ? directoryAgentsByPubkey.get(row.pubkey)
                      : undefined,
                  leaderPubkey,
                  memberOwnerPubkey:
                    row.pubkey !== ""
                      ? (verifiedAgents.byPubkey.get(row.pubkey)?.ownerPubkey ??
                        null)
                      : null,
                  viewerPubkey: me,
                })}
              />
            ))}
          </div>
          <Button
            aria-label="Add member row"
            data-testid="swarm-add-member-row"
            disabled={isSaving}
            onClick={() =>
              setRowState((current) =>
                appendEmptyMemberRow(current.rows, current.nextKey),
              )
            }
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Reporting</h3>
          <div className="flex items-center gap-3">
            <Switch
              checked={reportBack}
              data-testid="swarm-report-back"
              disabled={isSaving}
              id="swarm-report-back"
              onCheckedChange={setReportBack}
            />
            <label
              className="text-sm text-foreground"
              htmlFor="swarm-report-back"
            >
              Report back to leader on completion
            </label>
          </div>
          <div className="space-y-1.5">
            <div className={cn("px-3 py-2", PERSONA_FIELD_SHELL_CLASS)}>
              <Textarea
                className={cn(
                  "min-h-20 resize-none px-0 py-0",
                  PERSONA_FIELD_CONTROL_CLASS,
                )}
                data-testid="swarm-evaluation-criteria"
                disabled={isSaving || !reportBack}
                id="swarm-evaluation-criteria"
                onChange={(event) => setEvaluationCriteria(event.target.value)}
                value={evaluationCriteria}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Define evaluation and success criteria for the manager
            </p>
          </div>
        </section>
      </ChooserDialogContent>
    </Dialog>
  );
}

function SwarmMemberRowFields({
  disabled,
  onDescriptionChange,
  onPubkeyChange,
  onRemove,
  options,
  row,
  warning,
}: {
  disabled: boolean;
  onDescriptionChange: (description: string) => void;
  onPubkeyChange: (pubkey: string) => void;
  onRemove: () => void;
  options: { pubkey: string; label: string }[];
  row: SwarmMemberRow;
  warning: string | null;
}) {
  return (
    <div data-testid={`swarm-member-row-${row.key}`}>
      <div className="flex items-center gap-2">
        <div className="w-56 shrink-0">
          <AgentDropdownSelect
            disabled={disabled}
            emptyOptionsLabel="No agents left to add"
            id={`swarm-member-${row.key}-agent`}
            onValueChange={onPubkeyChange}
            options={options.map((option) => ({
              label: option.label,
              value: option.pubkey,
            }))}
            placeholder="Select agent"
            testId={`swarm-member-${row.key}-agent`}
            value={row.pubkey}
          />
        </div>
        <div
          className={cn(
            "flex min-h-9 flex-1 items-center px-3",
            PERSONA_FIELD_SHELL_CLASS,
          )}
        >
          <Input
            aria-label="Member task description"
            autoCorrect="off"
            className={cn(
              "h-8 px-0 py-0 leading-6",
              PERSONA_FIELD_CONTROL_CLASS,
            )}
            data-testid={`swarm-member-${row.key}-description`}
            disabled={disabled}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder={MEMBER_DESCRIPTION_PLACEHOLDER}
            value={row.description}
          />
        </div>
        <button
          aria-label="Remove member row"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={`swarm-member-${row.key}-remove`}
          disabled={disabled}
          onClick={onRemove}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {warning ? (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {warning}
        </p>
      ) : null}
    </div>
  );
}
