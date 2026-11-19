import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Loader2 } from "lucide-react";
import type { HostedEventSubscriptionRow } from "@/lib/apis/mcp-events-api";
import {
  EVENT_TRIGGER_DEFAULTS,
  EVENT_TRIGGER_LIMITS,
  dollarsToMicros,
  microsToDollars,
  type EventTriggerApprovalPolicy,
  type EventTriggerRow,
} from "@/lib/apis/event-triggers-api";

// Named for what RUNS, not for the stored value: `auto_deny` lets write
// tools run and denies only a tool that would need a person to approve it
// (nobody is watching an unattended run), so it is the more permissive one.
const APPROVAL_POLICY_LABELS: Record<EventTriggerApprovalPolicy, string> = {
  deny_writes: "Read-only tools only (writes refused)",
  auto_deny: "Allow writes (tools needing approval are refused)",
};

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

/** Create or edit one trigger; the subscription is fixed once created. */
export function TriggerForm({
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
              <option value="">You have no hosted subscriptions</option>
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
              Subscribe to an event in the Events tab first. A trigger can use
              only your own subscriptions.
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
          Runs are unattended, so tool calls that need approval are refused.
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
