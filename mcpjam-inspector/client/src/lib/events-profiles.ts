/**
 * The two MCP Events profiles (contract C1), as the Events tab needs them.
 *
 * Replicated from `sdk/src/events/profiles.ts` rather than imported: the
 * `@mcpjam/sdk/events` entry also carries the coordinator, the wire schemas
 * and the in-memory inbox, none of which belongs in the client bundle. Only
 * the facts the UI shows or filters by live here, and each one is the SDK
 * profile's documented value.
 */
import type {
  EventsDeliveryModeView,
  EventsProfileIdView,
} from "@/shared/events-api";

export const DRAFT_EVENTS_PROFILE_ID: EventsProfileIdView = "draft@28ec35e";
export const CHATGPT_EVENTS_PROFILE_ID: EventsProfileIdView =
  "chatgpt@2026-09-30";

/** The pinned working-group draft commit. */
export const EVENTS_DRAFT_COMMIT = "28ec35e";

export const EVENTS_DRAFT_SOURCE_URL =
  "https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/28ec35e905daa241f019981e2836b4a02f1c0368/docs/design-sketch-proposal.md";

export interface EventsProfileOption {
  id: EventsProfileIdView;
  /** Short label for pickers and badges. */
  label: string;
  /** One line on what judging by this profile means. */
  description: string;
  /** Delivery modes the profile's host uses (SDK `deliveryModes`). */
  deliveryModes: readonly EventsDeliveryModeView[];
}

export const EVENTS_PROFILES: readonly EventsProfileOption[] = [
  {
    id: DRAFT_EVENTS_PROFILE_ID,
    label: `Draft (${EVENTS_DRAFT_COMMIT})`,
    description:
      "The working-group draft pinned at 28ec35e: poll, push and webhook delivery.",
    deliveryModes: ["poll", "push", "webhook"],
  },
  {
    id: CHATGPT_EVENTS_PROFILE_ID,
    label: "ChatGPT (2026-09-30)",
    description:
      "What OpenAI documents for ChatGPT as of 2026-09-30: webhook delivery only.",
    deliveryModes: ["webhook"],
  },
];

export function getEventsProfile(id: EventsProfileIdView): EventsProfileOption {
  return (
    EVENTS_PROFILES.find((profile) => profile.id === id) ?? EVENTS_PROFILES[0]!
  );
}

const DELIVERY_MODES: readonly EventsDeliveryModeView[] = [
  "poll",
  "push",
  "webhook",
];

function isDeliveryMode(value: string): value is EventsDeliveryModeView {
  return (DELIVERY_MODES as readonly string[]).includes(value);
}

/**
 * Modes a subscription may use: advertised by the event's descriptor AND used
 * by the profile's host. Order follows the descriptor.
 */
export function usableDeliveryModes(
  advertised: readonly string[],
  profileId: EventsProfileIdView,
): EventsDeliveryModeView[] {
  const allowed = new Set(getEventsProfile(profileId).deliveryModes);
  const seen = new Set<EventsDeliveryModeView>();
  const usable: EventsDeliveryModeView[] = [];
  for (const mode of advertised) {
    if (!isDeliveryMode(mode) || !allowed.has(mode) || seen.has(mode)) continue;
    seen.add(mode);
    usable.push(mode);
  }
  return usable;
}
