import { Check, Circle } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import { ErrorCard } from "@/components/ui/error-card";
import type { EventsSubscriptionView } from "@/shared/events-api";
import { localWebhookFailure, readDeliveryStatus } from "./event-utils";

export function ReachabilityHeader({ subscription }: { subscription: EventsSubscriptionView }) {
  const stopped = subscription.desiredState !== "active" || subscription.observedState === "terminated";
  if (stopped) return null;

  const status = readDeliveryStatus(subscription.deliveryStatus);
  const failure = localWebhookFailure(subscription);
  const subscribed = subscription.serverSubscriptionId !== undefined || subscription.observedState === "active";
  const delivered = subscription.lastWebhookAt !== undefined || Boolean(status?.lastDeliveryAt);
  const reached = delivered || subscription.callbackVerifiedAt !== undefined;
  const receiving = delivered && !failure;
  let headline = "Subscribing";
  if (subscribed) headline = "Waiting for the first delivery";
  if (reached) headline = "Server reached MCPJam";
  if (receiving) headline = "Receiving webhook events";

  return (
    <div className="space-y-2 border-t border-border px-3 py-2">
      {failure ? (
        <ErrorCard
          error={{
            slug: "webhook/receiver",
            title: "Check webhook delivery settings",
            oneLine: failure,
            likelyCauses: [],
            nextSteps: [],
            severity: "error",
            origin: "user_server",
            docsAnchor: "/troubleshooting/error-codes",
            rawMessage: "",
          }}
          className="text-xs"
        />
      ) : (
        <p className="text-xs font-medium" data-testid="webhook-reachability">{headline}</p>
      )}
      <ol aria-label="Webhook reachability" className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {[
          { label: "Subscribed", complete: subscribed },
          { label: "Server reached MCPJam", complete: reached },
          { label: "Events arriving", complete: receiving },
        ].map(({ label, complete }) => {
          const Icon = complete ? Check : Circle;
          return (
            <li key={label} className={cn("flex items-center gap-1", !complete && "text-muted-foreground")}>
              <Icon aria-hidden="true" className={cn("size-3", complete && "text-success")} />
              <span className="sr-only">{complete ? "Complete: " : "Pending: "}</span>
              {label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
