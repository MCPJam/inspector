import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { Label } from "@mcpjam/design-system/label";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { Switch } from "@mcpjam/design-system/switch";
import { cn } from "@mcpjam/design-system/cn";
import { Pencil, Plus, Trash2, Zap } from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import { track } from "@/lib/analytics";
import { HOSTED_MODE } from "@/lib/config";
import { EVENT_SUBSCRIPTIONS_API } from "@/lib/apis/mcp-events-api";
import {
  CURRENT_USER_QUERY,
  EVENT_TRIGGERS_API,
  microsToDollars,
  type EventTriggerRow,
} from "@/lib/apis/event-triggers-api";
import { TriggerForm, type ValidatedTriggerFields } from "./events/TriggerForm";
import { RunDetail, RunHistory } from "./events/TriggerRuns";

export { PARKED_EXPLANATION } from "./events/TriggerRuns";
export type { ValidatedTriggerFields } from "./events/TriggerForm";

interface EventTriggersTabProps {
  /** The Convex project; triggers live in the hosted registry only. */
  projectId: string | null;
  /** A signed-in project member (guests cannot own unattended runs). */
  isSignedInMember: boolean;
}

function errorMessage(error: unknown, fallback: string): string {
  // The events backend refuses with `ConvexError({ code, message })` — e.g.
  // a trigger on someone else's subscription — and a ConvexError's own
  // `.message` is Convex's framing around that JSON, so read the data.
  if (error instanceof ConvexError) {
    const message = (error.data as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message) return message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

type Selection = { kind: "new" } | { kind: "trigger"; id: string } | null;

function TriggersWorkspace({ projectId }: { projectId: string }) {
  const triggers = useQuery(EVENT_TRIGGERS_API.list, { projectId });
  const subscriptionRows = useQuery(EVENT_SUBSCRIPTIONS_API.list, {
    projectId,
  });
  // The caller as the backend sees them. Only a subscription's owner can set
  // up, edit or enable its triggers (runs use the owner's credentials).
  const currentUserId = useQuery(CURRENT_USER_QUERY, {})?._id;
  const createTrigger = useMutation(EVENT_TRIGGERS_API.create);
  const updateTrigger = useMutation(EVENT_TRIGGERS_API.update);
  const setTriggerEnabled = useMutation(EVENT_TRIGGERS_API.setEnabled);
  const removeTrigger = useMutation(EVENT_TRIGGERS_API.remove);

  const [selection, setSelection] = useState<Selection>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Triggers run on the hosted runner, so only hosted, live subscriptions
  // can feed one, and only the caller's own.
  const eligibleSubscriptions = useMemo(
    () =>
      (subscriptionRows ?? []).filter(
        (row) =>
          currentUserId !== undefined &&
          row.ownerUserId === currentUserId &&
          (row.locality ?? "hosted") === "hosted" &&
          row.desiredState !== "removed",
      ),
    [subscriptionRows, currentUserId],
  );
  const subscriptionsById = useMemo(
    () => new Map((subscriptionRows ?? []).map((row) => [row._id, row])),
    [subscriptionRows],
  );

  const selectedTrigger =
    selection?.kind === "trigger"
      ? triggers?.find((trigger) => trigger._id === selection.id)
      : undefined;

  useEffect(() => {
    setSelectedRunId(null);
    setEditing(false);
  }, [selection]);

  const handleCreate = async (fields: ValidatedTriggerFields) => {
    setBusy(true);
    try {
      const triggerId = await createTrigger({ projectId, ...fields });
      toast.success(`Created ${fields.name}`);
      setSelection({ kind: "trigger", id: triggerId });
    } catch (error) {
      toast.error(
        errorMessage(
          error,
          "Could not create the trigger. Check the fields and try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async (
    trigger: EventTriggerRow,
    fields: ValidatedTriggerFields,
  ) => {
    setBusy(true);
    try {
      // The subscription is fixed for a trigger's life; `null` clears a model.
      await updateTrigger({
        triggerId: trigger._id,
        name: fields.name,
        instructions: fields.instructions,
        approvalPolicy: fields.approvalPolicy,
        maxSteps: fields.maxSteps,
        rateLimitPerHour: fields.rateLimitPerHour,
        spendCapMicrosPerDay: fields.spendCapMicrosPerDay,
        modelId: fields.modelId ?? null,
      });
      toast.success("Trigger saved");
      setEditing(false);
    } catch (error) {
      toast.error(
        errorMessage(
          error,
          "Could not save the trigger. Check the fields and try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (trigger: EventTriggerRow, enabled: boolean) => {
    try {
      await setTriggerEnabled({ triggerId: trigger._id, enabled });
    } catch (error) {
      toast.error(
        errorMessage(error, "Could not update the trigger. Try again."),
      );
    }
  };

  const handleRemove = async (trigger: EventTriggerRow) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Delete ${trigger.name}? Its past runs keep their history; pending runs are skipped.`,
      )
    ) {
      return;
    }
    try {
      await removeTrigger({ triggerId: trigger._id });
      setSelection(null);
    } catch (error) {
      toast.error(
        errorMessage(error, "Could not delete the trigger. Try again."),
      );
    }
  };

  const list = (
    <div className="flex h-full min-h-0 flex-col border-r border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold text-foreground">Triggers</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => setSelection({ kind: "new" })}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          New trigger
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {triggers === undefined ? (
            <p className="p-2 text-xs text-muted-foreground">Loading…</p>
          ) : triggers.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              No triggers yet.
            </p>
          ) : (
            <ul className="space-y-1" data-testid="trigger-list">
              {triggers.map((trigger) => {
                const subscription = subscriptionsById.get(
                  trigger.subscriptionId,
                );
                const active =
                  selection?.kind === "trigger" && selection.id === trigger._id;
                return (
                  <li key={trigger._id}>
                    <button
                      type="button"
                      onClick={() =>
                        setSelection({ kind: "trigger", id: trigger._id })
                      }
                      aria-pressed={active}
                      className={cn(
                        "w-full space-y-0.5 rounded-md px-2.5 py-2 text-left",
                        active ? "bg-accent" : "hover:bg-accent/60",
                      )}
                    >
                      <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                        {trigger.name}
                        {!trigger.enabled ? (
                          <Badge variant="outline" className="text-[9px]">
                            off
                          </Badge>
                        ) : null}
                      </span>
                      <span className="block font-mono text-[10px] text-muted-foreground">
                        {subscription?.eventName ?? "subscription removed"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </ScrollArea>
    </div>
  );

  let detail: React.ReactNode;
  if (selection?.kind === "new") {
    detail = (
      <section className="space-y-4 p-5">
        <h3 className="text-sm font-semibold text-foreground">New trigger</h3>
        <TriggerForm
          subscriptions={eligibleSubscriptions}
          busy={busy}
          onSubmit={handleCreate}
          onCancel={() => setSelection(null)}
        />
      </section>
    );
  } else if (selectedTrigger) {
    const subscription = subscriptionsById.get(selectedTrigger.subscriptionId);
    // Another member's trigger: the owner or a project admin may still stop
    // or delete it, but only the owner may edit or enable it.
    const ownsTrigger =
      currentUserId !== undefined &&
      subscription?.ownerUserId === currentUserId;
    detail = (
      <div className="space-y-6 p-5">
        <header className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            {selectedTrigger.name}
          </h3>
          <div className="flex items-center gap-2">
            <Switch
              id="trigger-enabled"
              checked={selectedTrigger.enabled}
              disabled={!ownsTrigger && !selectedTrigger.enabled}
              onCheckedChange={(checked) =>
                void handleToggle(selectedTrigger, checked)
              }
            />
            <Label htmlFor="trigger-enabled" className="text-xs">
              {selectedTrigger.enabled ? "Enabled" : "Disabled"}
            </Label>
          </div>
          <div className="ml-auto flex gap-1">
            {ownsTrigger ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setEditing((value) => !value)}
              >
                <Pencil className="mr-1 h-3 w-3" />
                {editing ? "Close editor" : "Edit"}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive hover:text-destructive"
              onClick={() => void handleRemove(selectedTrigger)}
            >
              <Trash2 className="mr-1 h-3 w-3" />
              Delete
            </Button>
          </div>
        </header>
        {ownsTrigger || currentUserId === undefined ? null : (
          <p className="text-[11px] text-muted-foreground">
            Only the subscription's owner can edit or turn on this trigger.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Event</dt>
            <dd className="font-mono text-foreground">
              {subscription?.eventName ?? "subscription removed"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Max steps</dt>
            <dd className="text-foreground">{selectedTrigger.maxSteps}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Runs per hour</dt>
            <dd className="text-foreground">
              {selectedTrigger.rateLimitPerHour}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Daily spend cap</dt>
            <dd className="text-foreground">
              $
              {microsToDollars(selectedTrigger.spendCapMicrosPerDay).toFixed(2)}
            </dd>
          </div>
        </dl>
        {editing && ownsTrigger ? (
          <TriggerForm
            trigger={selectedTrigger}
            subscriptions={eligibleSubscriptions}
            busy={busy}
            onSubmit={(fields) => handleUpdate(selectedTrigger, fields)}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <details className="text-[11px]">
            <summary className="cursor-pointer text-muted-foreground">
              Instructions
            </summary>
            <pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs text-foreground">
              {selectedTrigger.instructions}
            </pre>
          </details>
        )}
        <section className="space-y-2">
          <h4 className="text-xs font-semibold text-foreground">Run history</h4>
          <RunHistory
            triggerId={selectedTrigger._id}
            eventName={subscription?.eventName}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
          />
        </section>
        {selectedRunId ? (
          <section className="space-y-2">
            <h4 className="text-xs font-semibold text-foreground">Run</h4>
            <RunDetail runId={selectedRunId} />
          </section>
        ) : null}
      </div>
    );
  } else {
    detail = (
      <EmptyState
        icon={Zap}
        className="py-16"
        title="Run an agent when an event arrives"
        description="A trigger runs your instructions each time its subscription delivers an event. Tool calls that need approval are refused."
      >
        <Button size="sm" onClick={() => setSelection({ kind: "new" })}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New trigger
        </Button>
      </EmptyState>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[260px_minmax(0,1fr)]">
      {list}
      <ScrollArea className="h-full min-h-0">{detail}</ScrollArea>
    </div>
  );
}

export function EventTriggersTab({
  projectId,
  isSignedInMember,
}: EventTriggersTabProps) {
  useEffect(() => {
    track("triggers_tab_viewed", { location: "triggers_tab" });
  }, []);

  if (!projectId || !isSignedInMember) {
    return (
      <EmptyState
        icon={Zap}
        title="Triggers run on MCPJam's hosted runner"
        description={
          HOSTED_MODE
            ? "Sign in and open a project to create triggers."
            : "Sign in and open a hosted project to create triggers."
        }
      />
    );
  }
  return <TriggersWorkspace projectId={projectId} />;
}
