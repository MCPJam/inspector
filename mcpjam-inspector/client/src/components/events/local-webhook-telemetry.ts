import { track } from "@/lib/analytics";
import type { EventsSubscriptionView } from "@/shared/events-api";
import { LOCAL_WEBHOOK_FAILURE_CATEGORIES } from "@/shared/local-webhook-telemetry";

// Events and Playground can observe the same subscription. IDs only dedupe
// observations in this browser tab and never travel in the analytics event.
const lastFailures = new Map<string, string | undefined>();

export function observeLocalWebhookSubscription(
  subscription: EventsSubscriptionView | null | undefined,
): void {
  if (!subscription) return;
  const { id, locality, mode, receiverKind, lastError } = subscription;
  if (
    locality !== "local" ||
    mode !== "webhook" ||
    (receiverKind !== "local" && receiverKind !== "custom") ||
    typeof id !== "string"
  ) {
    return;
  }
  if (subscription.desiredState === "removed") {
    lastFailures.delete(id);
    return;
  }

  if (!lastFailures.has(id)) {
    track("local_webhook_receiver_selected", { receiver_kind: receiverKind });
  }
  const kind = lastError?.kind;
  const category =
    typeof kind === "string" && LOCAL_WEBHOOK_FAILURE_CATEGORIES.includes(kind)
      ? kind
      : undefined;
  if (category && category !== lastFailures.get(id)) {
    track("local_webhook_receiver_failed", {
      receiver_kind: receiverKind,
      failure_category: category,
    });
  }
  lastFailures.set(id, category);
}
