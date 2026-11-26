import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@mcpjam/design-system/collapsible";
import { cn } from "@mcpjam/design-system/cn";
import {
  AlertTriangle,
  Copy,
  ChevronRight,
  KeyRound,
  Pause,
  Play,
  ShieldCheck,
  X,
} from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { ReachabilityHeader } from "./ReachabilityHeader";
import { BUILT_IN_EVENTS_HOST_NAME } from "./use-events-host";
import type {
  EventsSlotStateResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";
import {
  END_SUBSCRIPTION_LABELS,
  formatCountdown,
  formatTime,
  hasInsecureLocalReceiver,
  observedStateLabel,
  observedStateTone,
  readDeliveryStatus,
  replayUnsupported,
  safeJson,
  type TerminationReason,
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

function DeliveryStatusFields({ value }: { value: unknown }) {
  const status = readDeliveryStatus(value);
  if (!status) return null;
  const state = status.suspended
    ? "Suspended after repeated failures"
    : status.throttled
      ? `Throttled${
          status.retryAfterMs !== undefined
            ? `, for about ${Math.ceil(status.retryAfterMs / 1000)}s`
            : ""
        }`
      : "Delivering";
  return (
    <>
      <Field label="Delivery">
        <span data-testid="delivery-state">{state}</span>
      </Field>
      {status.lastError ? (
        <Field label="lastError">{status.lastError}</Field>
      ) : null}
      {status.failedSince ? (
        <Field label="failedSince">{formatTime(status.failedSince)}</Field>
      ) : null}
      {status.lastDeliveryAt ? (
        <Field label="lastDeliveryAt">
          {formatTime(status.lastDeliveryAt)}
        </Field>
      ) : null}
    </>
  );
}

function SubscriptionCard({
  subscription,
  hosted,
  now,
  busy,
  slotState,
  termination,
  onAction,
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
  subscription: EventsSubscriptionView;
  hosted: boolean;
  now: number;
  busy: boolean;
  slotState?: EventsSlotStateResponse;
  termination: TerminationReason | null;
  onAction: (action: SubscriptionAction) => void;
}) {
  const removed = subscription.desiredState === "removed";
  const deliveryStatus = readDeliveryStatus(subscription.deliveryStatus);
  const deliveryNeedsAttention = deliveryStatus?.suspended || deliveryStatus?.throttled || Boolean(deliveryStatus?.lastError);
  const isWebhook = subscription.mode === "webhook";
  const localWebhook = isWebhook && !hosted;
  const desiredDiffers =
    subscription.desiredState !== subscription.observedState &&
    !(
      subscription.desiredState === "removed" &&
      subscription.observedState === "removing"
    );

  return (
    <Collapsible asChild defaultOpen={defaultOpen}>
    <li
      className="rounded-md border border-border bg-card"
      data-testid={`subscription-${subscription.id}`}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 p-3 text-left">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <div className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs font-semibold">{subscription.eventName}</span>
          <span className="text-[11px] text-muted-foreground">{subscription.mode}</span>
        </div>
        <span className={cn("rounded-sm border px-1.5 py-0.5 text-[10px] font-medium", observedStateTone(subscription.observedState))} data-testid="observed-state">
          {observedStateLabel(subscription.observedState)}
        </span>
        {desiredDiffers ? <span className="text-[10px] text-muted-foreground">Requested: {subscription.desiredState}</span> : null}
        {hasInsecureLocalReceiver(subscription) ? (
          <span className="text-[10px] text-warning" title="Uses plain HTTP for local development.">Plain HTTP</span>
        ) : null}
      </CollapsibleTrigger>

      {subscription.conflictingServerSubscriptionId ? (
        <div className="mx-3 mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
          <p>
            The server sent events under a different subscription ID,{" "}
            <code className="font-mono">
              {subscription.conflictingServerSubscriptionId}
            </code>
            {subscription.serverSubscriptionId ? (
              <>
                {" "}
                instead of{" "}
                <code className="font-mono">
                  {subscription.serverSubscriptionId}
                </code>
              </>
            ) : null}
            . The feed still records them with a Subscription mismatch flag.
          </p>
        </div>
      ) : null}

      {termination ? (
        <p
          className="mx-3 mb-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-foreground"
          data-testid="subscription-termination"
        >
          <span className="font-medium">{termination.label}</span>
          {termination.hint ? `. ${termination.hint}` : ""}
        </p>
      ) : subscription.lastError && !localWebhook ? (
        <p className="mx-3 mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">
          <span className="font-mono">{subscription.lastError.kind}</span>:{" "}
          {subscription.lastError.message}
          {subscription.lastError.retryable ? " (will retry)" : ""}
          {subscription.consecutiveFailures > 1
            ? ` · ${subscription.consecutiveFailures} failures in a row`
            : ""}
        </p>
      ) : null}

      {localWebhook && !termination ? <ReachabilityHeader subscription={subscription} /> : null}
      {hosted && isWebhook && deliveryNeedsAttention ? (
        <dl className="mx-3 mb-3 grid gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 sm:grid-cols-2">
          <DeliveryStatusFields value={subscription.deliveryStatus} />
        </dl>
      ) : null}
      <CollapsibleContent className="space-y-3 border-t border-border p-3">
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Client"><span data-testid="subscription-host">{subscription.host?.name ?? BUILT_IN_EVENTS_HOST_NAME}</span></Field>
        <Field label="Server subscription id">
          {subscription.serverSubscriptionId ?? "none yet"}
        </Field>
        {isWebhook ? (
          <Field label="Refresh before">
            {formatCountdown(subscription.refreshBefore, now)}
          </Field>
        ) : null}
        <Field label="cursor">
          {replayUnsupported(subscription)
            ? "null (replay not supported)"
            : (subscription.lastCursor ?? "none yet")}
        </Field>
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
          <Field label="Last gap (truncated)">
            {formatTime(subscription.lastGapAt)}
          </Field>
        ) : null}
        {hosted && isWebhook && !deliveryNeedsAttention ? (
          <DeliveryStatusFields value={subscription.deliveryStatus} />
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
      {hosted && subscription.deliveryStatus !== undefined ? (
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
            Inbox state: <span className="font-mono">{slotState.state}</span>
            {slotState.observedSubscriptionIds?.length
              ? ` · Seen subscription IDs: ${slotState.observedSubscriptionIds.join(", ")}`
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
              Check inbox
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
            <X className="mr-1 h-3 w-3" />
            {END_SUBSCRIPTION_LABELS[subscription.mode]}
          </Button>
        </div>
      ) : null}
    </CollapsibleContent>
    </li>
    </Collapsible>
  );
}

export function SubscriptionsPanel({
  subscriptions,
  hosted,
  busyId,
  slotStates,
  emptyText,
  terminationFor,
  onAction,
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
  subscriptions: EventsSubscriptionView[];
  hosted: boolean;
  busyId: string | null;
  slotStates: Record<string, EventsSlotStateResponse>;
  emptyText: string;
  /** Why a terminated subscription ended, when the feed says. */
  terminationFor: (
    subscription: EventsSubscriptionView,
  ) => TerminationReason | null;
  onAction: (
    subscription: EventsSubscriptionView,
    action: SubscriptionAction,
  ) => void;
}) {
  const now = useNow();
  if (subscriptions.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul className="space-y-2">
      {subscriptions.map((subscription) => (
        <SubscriptionCard
          key={subscription.id}
          subscription={subscription}
          defaultOpen={defaultOpen}
          hosted={hosted}
          now={now}
          busy={busyId === subscription.id}
          slotState={slotStates[subscription.id]}
          termination={terminationFor(subscription)}
          onAction={(action) => onAction(subscription, action)}
        />
      ))}
    </ul>
  );
}
