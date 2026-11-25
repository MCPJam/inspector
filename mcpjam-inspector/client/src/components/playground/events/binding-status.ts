import type { PlaygroundEventBinding } from "./PlaygroundEventsProvider";

/**
 * What a Playground event connection is doing right now, as the Events pane
 * shows it. The agent's `mcpjam_list_event_subscriptions` reports the same
 * words, so the model and the user never disagree about a subscription.
 */
export function bindingStatus(
  binding: Pick<PlaygroundEventBinding, "enabled" | "subscription">,
  options: { connected: boolean; feedStatus: string },
): string {
  if (!binding.enabled) return "Paused";
  if (!options.connected) return "Disconnected";
  if (!binding.subscription) return "Test only";
  if (binding.subscription.observedState !== "active")
    return binding.subscription.observedState;
  return options.feedStatus === "live" || options.feedStatus === "polling"
    ? "Listening"
    : options.feedStatus;
}
