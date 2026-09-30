import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@mcpjam/design-system/cn";
import {
  AlertTriangle,
  Copy,
  KeyRound,
  Pause,
  Play,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { getEventsProfile } from "@/lib/events-profiles";
import type {
  EventsSlotStateResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";
import {
  formatCountdown,
  formatTime,
  hasInsecureLocalReceiver,
  observedStateLabel,
  observedStateTone,
  safeJson,
} from "./event-utils";

/** A clock that ticks once a second while mounted, for the countdowns. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export type SubscriptionAction =
  | { kind: "state"; desiredState: EventsSubscriptionView["desiredState"] }
  | { kind: "rotate" }
  | { kind: "reauthorize" }
  | { kind: "slot-state" };

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-all font-mono text-[11px] text-foreground">
        {children}
      </dd>
    </div>
  );
}

function SubscriptionCard({
  subscription,
  hosted,
  now,
  busy,
  slotState,
  onAction,
}: {
  subscription: EventsSubscriptionView;
  hosted: boolean;
  now: number;
  busy: boolean;
  slotState?: EventsSlotStateResponse;
  onAction: (action: SubscriptionAction) => void;
}) {
  const removed = subscription.desiredState === "removed";
  const isWebhook = subscription.mode === "webhook";
  const desiredDiffers =
    subscription.desiredState !== subscription.observedState &&
    !(
      subscription.desiredState === "removed" &&
      subscription.observedState === "removing"
    );

  return (
    <li
      className="space-y-3 rounded-md border border-border bg-card p-3"
      data-testid={`subscription-${subscription.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-foreground">
          {subscription.eventName}
        </span>
        <Badge variant="outline" className="font-mono text-[10px]">
          {subscription.mode}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          {getEventsProfile(subscription.profile).label}
        </Badge>
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5 text-[10px] font-medium",
            observedStateTone(subscription.observedState),
          )}
          data-testid="observed-state"
        >
          {observedStateLabel(subscription.observedState)}
        </span>
        {desiredDiffers ? (
          <span className="text-[10px] text-muted-foreground">
            desired: {subscription.desiredState}
          </span>
        ) : null}
        {hasInsecureLocalReceiver(subscription) ? (
          <span
            className="rounded-sm border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground"
            title="Uses the local development receiver (plain http). Never a conformance pass."
          >
            Development override
          </span>
        ) : null}
      </div>

      {subscription.conflictingServerSubscriptionId ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
          <p>
            The server delivered under subscription id{" "}
            <code className="font-mono">
              {subscription.conflictingServerSubscriptionId}
            </code>
            , which differs from the reconciled id
            {subscription.serverSubscriptionId ? (
              <>
                {" "}
                <code className="font-mono">
                  {subscription.serverSubscriptionId}
                </code>
              </>
            ) : null}
            . Those deliveries are journalled with an id conflict flag.
          </p>
        </div>
      ) : null}

      {subscription.lastError ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">
          <span className="font-mono">{subscription.lastError.kind}</span>:{" "}
          {subscription.lastError.message}
          {subscription.lastError.retryable ? " (will retry)" : ""}
          {subscription.consecutiveFailures > 1
            ? ` · ${subscription.consecutiveFailures} failures in a row`
            : ""}
        </p>
      ) : null}

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Server subscription id">
          {subscription.serverSubscriptionId ?? "none yet"}
        </Field>
        <Field label="Refresh before">
          {formatCountdown(subscription.refreshBefore, now)}
        </Field>
        <Field label="Last cursor">{subscription.lastCursor ?? "none"}</Field>
        <Field label="Generation">{subscription.generation}</Field>
        {isWebhook ? (
          <div className="min-w-0 space-y-0.5 sm:col-span-2">
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Callback URL
            </dt>
            <dd className="flex min-w-0 items-center gap-1">
              <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">
                {subscription.callbackUrl ??
                  "allocated on the first keeper step"}
              </code>
              {subscription.callbackUrl ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  title="Copy callback URL"
                  aria-label="Copy callback URL"
                  onClick={() =>
                    void copyToClipboard(subscription.callbackUrl!)
                  }
                >
                  <Copy className="h-3 w-3" />
                </Button>
              ) : null}
            </dd>
          </div>
        ) : null}
        {subscription.lastGapAt ? (
          <Field label="Last gap">{formatTime(subscription.lastGapAt)}</Field>
        ) : null}
      </dl>

      {Object.keys(subscription.arguments ?? {}).length > 0 ? (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">
            Arguments
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
            {safeJson(subscription.arguments)}
          </pre>
        </details>
      ) : null}
      {subscription.deliveryStatus !== undefined ? (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">
            Delivery status
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
            {safeJson(subscription.deliveryStatus)}
          </pre>
        </details>
      ) : null}
      {slotState ? (
        <div className="space-y-1 rounded-md border border-border p-2 text-[11px]">
          <p className="text-muted-foreground">
            Slot state: <span className="font-mono">{slotState.state}</span>
            {slotState.observedSubscriptionIds?.length
              ? ` · observed ids ${slotState.observedSubscriptionIds.join(", ")}`
              : ""}
          </p>
          {slotState.counts ? (
            <p className="font-mono text-muted-foreground">
              {Object.entries(slotState.counts)
                .map(([key, value]) => `${key}: ${value}`)
                .join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {!removed ? (
        <div className="flex flex-wrap gap-1.5">
          {subscription.desiredState === "active" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() =>
                onAction({ kind: "state", desiredState: "paused" })
              }
            >
              <Pause className="mr-1 h-3 w-3" />
              Pause
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() =>
                onAction({ kind: "state", desiredState: "active" })
              }
            >
              <Play className="mr-1 h-3 w-3" />
              Resume
            </Button>
          )}
          {isWebhook ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => onAction({ kind: "rotate" })}
            >
              <KeyRound className="mr-1 h-3 w-3" />
              Rotate secret
            </Button>
          ) : null}
          {hosted && subscription.observedState === "paused_auth" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => onAction({ kind: "reauthorize" })}
            >
              <ShieldCheck className="mr-1 h-3 w-3" />
              Reauthorize
            </Button>
          ) : null}
          {hosted && isWebhook ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => onAction({ kind: "slot-state" })}
            >
              Check slot
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => onAction({ kind: "state", desiredState: "removed" })}
          >
            <Trash2 className="mr-1 h-3 w-3" />
            Remove
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function SubscriptionsPanel({
  subscriptions,
  hosted,
  busyId,
  slotStates,
  onAction,
}: {
  subscriptions: EventsSubscriptionView[];
  hosted: boolean;
  busyId: string | null;
  slotStates: Record<string, EventsSlotStateResponse>;
  onAction: (
    subscription: EventsSubscriptionView,
    action: SubscriptionAction,
  ) => void;
}) {
  const now = useNow();
  if (subscriptions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No subscriptions on this server yet. Subscribe to an event type above.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {subscriptions.map((subscription) => (
        <SubscriptionCard
          key={subscription.id}
          subscription={subscription}
          hosted={hosted}
          now={now}
          busy={busyId === subscription.id}
          slotState={slotStates[subscription.id]}
          onAction={(action) => onAction(subscription, action)}
        />
      ))}
    </ul>
  );
}
