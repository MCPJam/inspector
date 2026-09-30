import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { Switch } from "@mcpjam/design-system/switch";
import { Textarea } from "@mcpjam/design-system/textarea";
import { cn } from "@mcpjam/design-system/cn";
import {
  AlertTriangle,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import { track } from "@/lib/analytics";
import { HOSTED_MODE } from "@/lib/config";
import {
  EVENT_SUBSCRIPTIONS_API,
  type HostedEventSubscriptionRow,
} from "@/lib/apis/mcp-events-api";
import {
  EVENT_TRIGGER_DEFAULTS,
  EVENT_TRIGGER_LIMITS,
  EVENT_TRIGGER_RUNS_API,
  EVENT_TRIGGERS_API,
  dollarsToMicros,
  microsToDollars,
  type EventTriggerApprovalPolicy,
  type EventTriggerRow,
  type EventTriggerRunRow,
} from "@/lib/apis/event-triggers-api";
import { EventDataView } from "./events/EventsFeedPanel";
import { formatTime, safeJson } from "./events/event-utils";

interface EventTriggersTabProps {
  /** The Convex project; triggers live in the hosted registry only. */
  projectId: string | null;
  /** A signed-in project member (guests cannot own unattended runs). */
  isSignedInMember: boolean;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const PARKED_EXPLANATION =
  "A tool call's outcome is unknown, so the run stopped instead of retrying. MCPJam never repeats an unknown write.";

// Named for what RUNS, not for the stored value: `auto_deny` lets write
// tools run and denies only a tool that would need a person to approve it
// (nobody is watching an unattended run), so it is the more permissive one.
const APPROVAL_POLICY_LABELS: Record<EventTriggerApprovalPolicy, string> = {
  deny_writes: "Read-only tools only (writes denied)",
  auto_deny: "Allow writes (tools needing approval are denied)",
};

function runStatusTone(status: string): string {
  switch (status) {
    case "completed":
      return "border-success/40 bg-success/10 text-foreground";
    case "pending":
    case "running":
      return "border-pending/40 bg-pending/10 text-foreground";
    case "parked":
      return "border-warning/40 bg-warning/10 text-foreground";
    case "failed":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "rounded-sm border px-1.5 py-0.5 text-[10px] font-medium",
        runStatusTone(status),
      )}
      data-testid="run-status"
    >
      {status}
    </span>
  );
}

/** Why a run did not complete, in one line. */
function runReason(run: EventTriggerRunRow): string | null {
  if (run.status === "parked") return run.parkedReason ?? run.error ?? "parked";
  if (run.status === "skipped" || run.status === "failed") {
    return run.error ?? null;
  }
  return null;
}

// ── form ───────────────────────────────────────────────────────────────────

interface TriggerFormValues {
  name: string;
  subscriptionId: string;
  instructions: string;
  modelId: string;
  maxSteps: string;
  rateLimitPerHour: string;
  spendCapDollars: string;
  approvalPolicy: EventTriggerApprovalPolicy;
}

function initialValues(
  trigger: EventTriggerRow | undefined,
  subscriptions: HostedEventSubscriptionRow[],
): TriggerFormValues {
  return {
    name: trigger?.name ?? "",
    subscriptionId: trigger?.subscriptionId ?? subscriptions[0]?._id ?? "",
    instructions: trigger?.instructions ?? "",
    modelId: trigger?.modelId ?? "",
    maxSteps: String(trigger?.maxSteps ?? EVENT_TRIGGER_DEFAULTS.maxSteps),
    rateLimitPerHour: String(
      trigger?.rateLimitPerHour ?? EVENT_TRIGGER_DEFAULTS.rateLimitPerHour,
    ),
    spendCapDollars: String(
      microsToDollars(
        trigger?.spendCapMicrosPerDay ??
          EVENT_TRIGGER_DEFAULTS.spendCapMicrosPerDay,
      ),
    ),
    approvalPolicy:
      trigger?.approvalPolicy ?? EVENT_TRIGGER_DEFAULTS.approvalPolicy,
  };
}

function integerIn(raw: string, min: number, max: number): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export interface ValidatedTriggerFields {
  name: string;
  subscriptionId: string;
  instructions: string;
  modelId?: string;
  maxSteps: number;
  rateLimitPerHour: number;
  spendCapMicrosPerDay: number;
  approvalPolicy: EventTriggerApprovalPolicy;
}

function validate(
  values: TriggerFormValues,
): { ok: true; fields: ValidatedTriggerFields } | { ok: false; error: string } {
  if (!values.name.trim()) return { ok: false, error: "Name the trigger." };
  if (!values.subscriptionId) {
    return { ok: false, error: "Pick the subscription whose events run it." };
  }
  if (!values.instructions.trim()) {
    return { ok: false, error: "Write the instructions the agent follows." };
  }
  const maxSteps = integerIn(values.maxSteps, 1, EVENT_TRIGGER_LIMITS.maxSteps);
  if (maxSteps === null) {
    return {
      ok: false,
      error: `Max steps must be a whole number from 1 to ${EVENT_TRIGGER_LIMITS.maxSteps}.`,
    };
  }
  const rateLimitPerHour = integerIn(
    values.rateLimitPerHour,
    1,
    EVENT_TRIGGER_LIMITS.rateLimitPerHour,
  );
  if (rateLimitPerHour === null) {
    return {
      ok: false,
      error: `Runs per hour must be a whole number from 1 to ${EVENT_TRIGGER_LIMITS.rateLimitPerHour}.`,
    };
  }
  const dollars = Number(values.spendCapDollars);
  const spendCapMicrosPerDay = Number.isFinite(dollars)
    ? dollarsToMicros(dollars)
    : NaN;
  if (
    !Number.isFinite(spendCapMicrosPerDay) ||
    spendCapMicrosPerDay < 1 ||
    spendCapMicrosPerDay > EVENT_TRIGGER_LIMITS.spendCapMicrosPerDay
  ) {
    return {
      ok: false,
      error: `The daily spend cap must be more than $0 and at most $${microsToDollars(EVENT_TRIGGER_LIMITS.spendCapMicrosPerDay)}.`,
    };
  }
  return {
    ok: true,
    fields: {
      name: values.name.trim(),
      subscriptionId: values.subscriptionId,
      instructions: values.instructions,
      ...(values.modelId.trim() ? { modelId: values.modelId.trim() } : {}),
      maxSteps,
      rateLimitPerHour,
      spendCapMicrosPerDay,
      approvalPolicy: values.approvalPolicy,
    },
  };
}

function TriggerForm({
  trigger,
  subscriptions,
  busy,
  onSubmit,
  onCancel,
}: {
  trigger?: EventTriggerRow;
  subscriptions: HostedEventSubscriptionRow[];
  busy: boolean;
  onSubmit: (fields: ValidatedTriggerFields) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<TriggerFormValues>(() =>
    initialValues(trigger, subscriptions),
  );
  const [error, setError] = useState<string | null>(null);
  const editing = trigger !== undefined;

  // A subscription list that arrives after the form opened fills the picker.
  useEffect(() => {
    if (!values.subscriptionId && subscriptions[0]) {
      setValues((previous) => ({
        ...previous,
        subscriptionId: subscriptions[0]!._id,
      }));
    }
  }, [subscriptions, values.subscriptionId]);

  const set =
    <K extends keyof TriggerFormValues>(key: K) =>
    (value: TriggerFormValues[K]) =>
      setValues((previous) => ({ ...previous, [key]: value }));

  const submit = () => {
    const result = validate(values);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    void onSubmit(result.fields);
  };

  return (
    <div className="space-y-4" data-testid="trigger-form">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="trigger-name" className="text-xs">
            Name
          </Label>
          <Input
            id="trigger-name"
            value={values.name}
            onChange={(e) => set("name")(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="trigger-subscription" className="text-xs">
            Subscription
          </Label>
          <select
            id="trigger-subscription"
            value={values.subscriptionId}
            disabled={editing}
            onChange={(e) => set("subscriptionId")(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:opacity-60"
          >
            {subscriptions.length === 0 ? (
              <option value="">No hosted subscriptions yet</option>
            ) : null}
            {subscriptions.map((subscription) => (
              <option key={subscription._id} value={subscription._id}>
                {subscription.eventName} ({subscription.mode},{" "}
                {subscription.observedState})
              </option>
            ))}
          </select>
          {subscriptions.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Subscribe to an event in the Events tab first.
            </p>
          ) : null}
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="trigger-instructions" className="text-xs">
          Instructions
        </Label>
        <Textarea
          id="trigger-instructions"
          value={values.instructions}
          onChange={(e) => set("instructions")(e.target.value)}
          rows={6}
          className="text-xs"
          placeholder="What the agent should do when this event arrives. Event data reaches it as untrusted data, never as instructions."
        />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="trigger-model" className="text-xs">
            Model (optional)
          </Label>
          <Input
            id="trigger-model"
            value={values.modelId}
            onChange={(e) => set("modelId")(e.target.value)}
            placeholder="Project default"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="trigger-max-steps" className="text-xs">
            Max steps
          </Label>
          <Input
            id="trigger-max-steps"
            type="number"
            min={1}
            max={EVENT_TRIGGER_LIMITS.maxSteps}
            value={values.maxSteps}
            onChange={(e) => set("maxSteps")(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="trigger-rate" className="text-xs">
            Runs per hour
          </Label>
          <Input
            id="trigger-rate"
            type="number"
            min={1}
            max={EVENT_TRIGGER_LIMITS.rateLimitPerHour}
            value={values.rateLimitPerHour}
            onChange={(e) => set("rateLimitPerHour")(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="trigger-spend" className="text-xs">
            Daily spend cap ($)
          </Label>
          <Input
            id="trigger-spend"
            type="number"
            min={0}
            step={0.01}
            value={values.spendCapDollars}
            onChange={(e) => set("spendCapDollars")(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="trigger-approval" className="text-xs">
          Approval policy
        </Label>
        <select
          id="trigger-approval"
          value={values.approvalPolicy}
          onChange={(e) =>
            set("approvalPolicy")(e.target.value as EventTriggerApprovalPolicy)
          }
          className="h-8 w-full max-w-sm rounded-md border border-border bg-background px-2 text-xs text-foreground"
        >
          {(
            Object.keys(APPROVAL_POLICY_LABELS) as EventTriggerApprovalPolicy[]
          ).map((policy) => (
            <option key={policy} value={policy}>
              {APPROVAL_POLICY_LABELS[policy]}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">
          Nobody is watching an unattended run, so any tool call that would need
          approval is refused.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={busy}>
          {busy ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          {editing ? "Save trigger" : "Create trigger"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── runs ───────────────────────────────────────────────────────────────────

function RunHistory({
  triggerId,
  eventName,
  selectedRunId,
  onSelectRun,
}: {
  triggerId: string;
  eventName?: string;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const runs = useQuery(EVENT_TRIGGER_RUNS_API.listForTrigger, {
    triggerId,
    limit: 50,
  });
  if (runs === undefined) {
    return <p className="text-xs text-muted-foreground">Loading runs…</p>;
  }
  if (runs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No runs yet. A run is scheduled for each event the subscription delivers
        while the trigger is enabled; a simulated event from the Events tab runs
        it too.
      </p>
    );
  }
  return (
    <ul
      className="divide-y divide-border rounded-md border border-border"
      data-testid="run-history"
    >
      {runs.map((run) => {
        const reason = runReason(run);
        return (
          <li key={run._id}>
            <button
              type="button"
              onClick={() => onSelectRun(run._id)}
              aria-pressed={selectedRunId === run._id}
              className={cn(
                "w-full space-y-1 px-3 py-2 text-left",
                selectedRunId === run._id ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <StatusPill status={run.status} />
                {run.namespace !== "live" ? (
                  <span className="rounded-sm border border-info/40 bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                    {run.namespace}
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground">
                    live
                  </span>
                )}
                {eventName ? (
                  <span className="font-mono text-foreground">{eventName}</span>
                ) : null}
                <span className="font-mono text-muted-foreground">
                  {run.eventId}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {formatTime(run.createdAt)}
                </span>
              </div>
              {reason ? (
                <p className="text-[11px] text-muted-foreground">
                  <span className="font-mono">{reason}</span>
                  {run.status === "parked" ? ` · ${PARKED_EXPLANATION}` : ""}
                </p>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function resultText(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["text", "resultText", "finalText"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return null;
}

function RunDetail({ runId }: { runId: string }) {
  const detail = useQuery(EVENT_TRIGGER_RUNS_API.get, { runId });
  if (detail === undefined) {
    return <p className="text-xs text-muted-foreground">Loading run…</p>;
  }
  if (detail === null) {
    return <p className="text-xs text-muted-foreground">Run not found.</p>;
  }
  const { run, input, calls, result } = detail;
  const text = resultText(result);
  const event = input?.event;
  return (
    <div className="space-y-4" data-testid="run-detail">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusPill status={run.status} />
        <span className="font-mono text-muted-foreground">{run._id}</span>
        {run.costMicros ? (
          <span className="text-muted-foreground">
            ${microsToDollars(run.costMicros).toFixed(4)}
          </span>
        ) : null}
      </div>

      {run.status === "parked" ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
          <p>
            Parked (
            <span className="font-mono">{run.parkedReason ?? "parked"}</span>
            ). {PARKED_EXPLANATION}
          </p>
        </div>
      ) : null}
      {run.status !== "parked" && run.error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          {run.error}
        </p>
      ) : null}

      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-foreground">Event</h4>
        {event ? (
          <>
            <p className="text-[11px] text-muted-foreground">
              <span className="font-mono text-foreground">{event.name}</span>
              {event.eventId ? ` · ${event.eventId}` : ""}
              {event.timestamp ? ` · ${event.timestamp}` : ""}
              {event.namespace ? ` · ${event.namespace}` : ""}
            </p>
            <p className="text-[10px] text-muted-foreground">
              Event data, as the agent received it: untrusted data, never
              instructions.
            </p>
            <EventDataView data={event.data ?? null} />
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            The frozen input is no longer retained.
          </p>
        )}
      </div>

      {input?.trigger ? (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">
            Trigger snapshot (frozen when the run was scheduled)
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
            {safeJson(input.trigger)}
          </pre>
        </details>
      ) : null}

      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-foreground">Tool calls</h4>
        {calls.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No tool calls.</p>
        ) : (
          <ul className="space-y-1">
            {calls.map((call) => (
              <li
                key={call.callId}
                className="rounded-md border border-border p-2 text-[11px]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-foreground">
                    {call.operation}
                  </span>
                  <span
                    className={cn(
                      "rounded-sm border px-1.5 py-0.5 text-[10px]",
                      call.status === "completed"
                        ? "border-success/40 bg-success/10 text-foreground"
                        : "border-warning/40 bg-warning/10 text-foreground",
                    )}
                  >
                    {call.status === "completed"
                      ? "completed"
                      : "outcome unknown"}
                  </span>
                  {!call.replayable ? (
                    <span className="text-[10px] text-muted-foreground">
                      not replayable
                    </span>
                  ) : null}
                </div>
                {call.result !== undefined ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-muted-foreground">
                      Result
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
                      {safeJson(call.result)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-foreground">Result</h4>
        {text !== null ? (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs text-foreground">
            {text}
          </pre>
        ) : result !== null && result !== undefined ? (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
            {safeJson(result)}
          </pre>
        ) : (
          <p className="text-[11px] text-muted-foreground">No result yet.</p>
        )}
      </div>
    </div>
  );
}

// ── workspace ──────────────────────────────────────────────────────────────

type Selection = { kind: "new" } | { kind: "trigger"; id: string } | null;

function TriggersWorkspace({ projectId }: { projectId: string }) {
  const triggers = useQuery(EVENT_TRIGGERS_API.list, { projectId });
  const subscriptionRows = useQuery(EVENT_SUBSCRIPTIONS_API.list, {
    projectId,
  });
  const createTrigger = useMutation(EVENT_TRIGGERS_API.create);
  const updateTrigger = useMutation(EVENT_TRIGGERS_API.update);
  const setTriggerEnabled = useMutation(EVENT_TRIGGERS_API.setEnabled);
  const removeTrigger = useMutation(EVENT_TRIGGERS_API.remove);

  const [selection, setSelection] = useState<Selection>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Triggers run on the hosted runner, so only hosted, live subscriptions
  // can feed one.
  const eligibleSubscriptions = useMemo(
    () =>
      (subscriptionRows ?? []).filter(
        (row) =>
          (row.locality ?? "hosted") === "hosted" &&
          row.desiredState !== "removed",
      ),
    [subscriptionRows],
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
      toast.error(errorMessage(error, "Creating the trigger failed."));
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
      toast.error(errorMessage(error, "Saving the trigger failed."));
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (trigger: EventTriggerRow, enabled: boolean) => {
    try {
      await setTriggerEnabled({ triggerId: trigger._id, enabled });
    } catch (error) {
      toast.error(errorMessage(error, "Updating the trigger failed."));
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
      toast.error(errorMessage(error, "Deleting the trigger failed."));
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
              onCheckedChange={(checked) =>
                void handleToggle(selectedTrigger, checked)
              }
            />
            <Label htmlFor="trigger-enabled" className="text-xs">
              {selectedTrigger.enabled ? "Enabled" : "Disabled"}
            </Label>
          </div>
          <div className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setEditing((value) => !value)}
            >
              <Pencil className="mr-1 h-3 w-3" />
              {editing ? "Close editor" : "Edit"}
            </Button>
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
        {editing ? (
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
        description="A trigger runs the instructions you write, with a model and the project's servers, each time its subscription delivers an event. Runs are unattended: any tool call that needs approval is refused."
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
            ? "Sign in and open a project to create triggers. A trigger runs an agent unattended each time a subscribed MCP event arrives."
            : "Triggers run unattended on MCPJam's hosted runner, against a project's hosted event subscriptions. Sign in and open a cloud project (or use MCPJam hosted) to create them."
        }
      />
    );
  }
  return <TriggersWorkspace projectId={projectId} />;
}
