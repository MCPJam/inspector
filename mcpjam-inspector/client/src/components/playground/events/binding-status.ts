import type { PlaygroundEventBinding } from "./PlaygroundEventsProvider";

/**
 * What a Playground event connection is doing right now, as the Events pane
 * shows it. The agent's event tools report the same words, so the model and
 * the user never disagree about a subscription.
 *
 * A watch that isn't listening yet but will be on its own reads "Connecting":
 * the server hasn't confirmed a new subscription (`pending`), or the live feed
 * hasn't opened (`idle` before the first subscription, then `connecting`).
 * The agent relays this word, so it must not sound like something is wrong.
 */
export function bindingStatus(
  binding: Pick<PlaygroundEventBinding, "enabled" | "subscription">,
  options: { connected: boolean; feedStatus: string },
): string {
  if (!binding.enabled) return "Paused";
  if (!options.connected) return "Disconnected";
  if (!binding.subscription) return "Test only";
  const { observedState } = binding.subscription;
  if (observedState === "pending") return "Connecting";
  if (observedState !== "active") return observedState;
  switch (options.feedStatus) {
    case "live":
    case "polling":
      return "Listening";
    case "idle":
    case "connecting":
      return "Connecting";
    default:
      return options.feedStatus;
  }
}
