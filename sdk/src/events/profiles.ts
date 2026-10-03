/**
 * MCP Events profiles (contract C1).
 *
 * A profile names WHICH rulebook a result, an emulation or a UI label is
 * judged by. There are two, and they are not ordered — ChatGPT's is not a
 * "stricter draft", it is a different, dated product surface:
 *
 *   - `draft@28ec35e` — the pinned working-group draft.
 *   - `chatgpt@2026-09-30` — what OpenAI documents for ChatGPT, plus what we
 *     have observed ourselves (dated), plus MCPJam policy where ChatGPT's
 *     internals cannot be observed. Every field says which of those it is.
 *
 * Development overrides (e.g. the plain-http fixture mode) are NOT a profile:
 * they are recorded on the run, always labelled, and never count as a pass.
 */

export const DRAFT_PROFILE_ID = "draft@28ec35e" as const;
export const CHATGPT_PROFILE_ID = "chatgpt@2026-09-30" as const;
export type EventsProfileId = typeof DRAFT_PROFILE_ID | typeof CHATGPT_PROFILE_ID;
export const EVENTS_PROFILE_IDS: readonly EventsProfileId[] = [
  DRAFT_PROFILE_ID,
  CHATGPT_PROFILE_ID,
];

export const DRAFT_SOURCE_URL =
  "https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/28ec35e905daa241f019981e2836b4a02f1c0368/docs/design-sketch-proposal.md";
export const CHATGPT_SOURCE_URL =
  "https://developers.openai.com/plugins/build/mcp-events";

/**
 * Where a profile fact comes from. `unobserved` marks a field whose value
 * needs a live observation that has not been run — it is shown as a gap,
 * never as fact.
 */
export type ProfileProvenance =
  | { kind: "documented"; source: string; section?: string }
  | { kind: "observed"; date: string; probe: string }
  | { kind: "policy"; note: string }
  | { kind: "unobserved"; probe: string };

export interface ProfileFact<T> {
  value: T;
  provenance: ProfileProvenance;
}

export type DeliveryMode = "poll" | "push" | "webhook";

export interface EventsProfile {
  id: EventsProfileId;
  title: string;
  /** Where the host reads the capability. */
  capabilityPlacement: ProfileFact<"capabilities.events">;
  protocolVersions: ProfileFact<string[]>;
  deliveryModes: ProfileFact<DeliveryMode[]>;
  /** Control envelopes the host handles. */
  controlEnvelopes: ProfileFact<Array<"gap" | "terminated" | "verification">>;
  /** Max delivery body, bytes, and whether exceeding it is a MUST failure. */
  maxBodyBytes: ProfileFact<{ bytes: number; strength: "MUST" | "SHOULD" }>;
  /** Status codes after which a sender must not retry a delivery. */
  nonRetryableStatuses: ProfileFact<number[]>;
  /** Receiver consent method the host uses. */
  consentMethods: ProfileFact<
    Array<"challenge" | "allowlist" | "out-of-band" | "well-known">
  >;
  /** Whether the host sends `ttlMs`, and what value. */
  requestedTtlMs: ProfileFact<number | null | "omitted" | "unknown">;
  /** Secret length the host generates, in bytes. */
  secretBytes: ProfileFact<number | "unknown">;
  /** How long before `refreshBefore` the host refreshes. */
  refreshLead: ProfileFact<string>;
  /** Whether ending the chat/automation unsubscribes. */
  unsubscribesOnEnd: ProfileFact<boolean | "unknown">;
  /** Event batching into one agent turn. */
  batching: ProfileFact<"off" | "host-setting">;
  /** How long received events are retained. */
  retention: ProfileFact<string>;
  /** How event data is presented to the model. */
  prompting: ProfileFact<string>;
  /** Minimum poll interval the client enforces. */
  pollFloorMs: ProfileFact<number>;
}

const draft = (section: string): ProfileProvenance => ({
  kind: "documented",
  source: DRAFT_SOURCE_URL,
  section,
});
const openai = (section: string): ProfileProvenance => ({
  kind: "documented",
  source: CHATGPT_SOURCE_URL,
  section,
});
const policy = (note: string): ProfileProvenance => ({ kind: "policy", note });
const probe = "sdk/scripts/chatgpt-events-probe.ts";

export const DRAFT_PROFILE: EventsProfile = {
  id: DRAFT_PROFILE_ID,
  title: "MCP Events draft (working group, pinned 28ec35e)",
  capabilityPlacement: {
    value: "capabilities.events",
    provenance: draft("Capability Declaration"),
  },
  protocolVersions: {
    value: ["2025-11-25", "2026-07-28"],
    provenance: policy(
      "The draft is version-agnostic; MCPJam exercises it on both eras it speaks."
    ),
  },
  deliveryModes: {
    value: ["poll", "push", "webhook"],
    provenance: draft("Subscribing and Event Delivery"),
  },
  controlEnvelopes: {
    value: ["gap", "terminated", "verification"],
    provenance: draft("Non-event webhook bodies"),
  },
  maxBodyBytes: {
    value: { bytes: 256 * 1024, strength: "SHOULD" },
    provenance: draft("Delivery profile"),
  },
  nonRetryableStatuses: {
    value: [410, 413],
    provenance: draft("Webhook Event Delivery; Delivery profile"),
  },
  consentMethods: {
    value: ["challenge", "allowlist", "out-of-band", "well-known"],
    provenance: draft("Endpoint verification"),
  },
  requestedTtlMs: {
    value: 60 * 60 * 1000,
    provenance: policy("MCPJam requests one hour; servers may clamp."),
  },
  secretBytes: {
    value: 32,
    provenance: policy("CSPRNG, middle of the draft's 24–64 byte window."),
  },
  refreshLead: {
    value: "max(60 s, 10% of the remaining grant) before refreshBefore",
    provenance: policy("MCPJam keeper schedule."),
  },
  unsubscribesOnEnd: {
    value: true,
    provenance: policy("Removing a subscription in MCPJam always unsubscribes."),
  },
  batching: {
    value: "off",
    provenance: policy("One event, one turn, unless a host profile opts in."),
  },
  retention: {
    value:
      "UI history 7 days / 5,000 entries per inbox; pending work 72 h; dedupe 7 days (proposed)",
    provenance: policy("MCPJam inbox policy — open question 1 in the plan."),
  },
  prompting: {
    value:
      "Event data is passed as an untrusted, clearly delimited context block; the trigger's instructions are the only instructions.",
    provenance: policy("MCPJam event-job executor."),
  },
  pollFloorMs: {
    value: 1000,
    provenance: draft("Poll-Based Delivery (nextPollMs floor, default 1000 ms)"),
  },
};

export const CHATGPT_PROFILE: EventsProfile = {
  id: CHATGPT_PROFILE_ID,
  title: "ChatGPT (as of 2026-09-30)",
  capabilityPlacement: {
    value: "capabilities.events",
    provenance: openai("Advertise event support"),
  },
  protocolVersions: {
    value: ["2026-07-28"],
    provenance: openai("Before you start"),
  },
  deliveryModes: {
    value: ["webhook"],
    provenance: openai("Before you start"),
  },
  controlEnvelopes: {
    value: ["verification"],
    provenance: openai(
      "Before you start (gap and terminated are not supported); Verify the callback"
    ),
  },
  maxBodyBytes: {
    value: { bytes: 262_144, strength: "MUST" },
    provenance: openai("Handle delivery responses"),
  },
  nonRetryableStatuses: {
    value: [410, 413],
    provenance: openai("Handle delivery responses"),
  },
  consentMethods: {
    value: ["challenge"],
    provenance: openai("Verify the callback"),
  },
  requestedTtlMs: {
    value: "unknown",
    provenance: { kind: "unobserved", probe },
  },
  secretBytes: {
    value: "unknown",
    provenance: { kind: "unobserved", probe },
  },
  refreshLead: {
    value: "before refreshBefore (exact lead unknown)",
    provenance: { kind: "unobserved", probe },
  },
  unsubscribesOnEnd: {
    value: true,
    provenance: openai(
      "Test in ChatGPT, step 9 (stop monitoring → events/unsubscribe)"
    ),
  },
  batching: {
    value: "host-setting",
    provenance: openai("Handle delivery responses (task batching settings)"),
  },
  retention: {
    value:
      "Not observable. MCPJam emulation applies its own inbox policy (7 days / 5,000 entries; pending 72 h).",
    provenance: policy(
      "ChatGPT's retention is internal; this is MCPJam's stated policy, not ChatGPT's."
    ),
  },
  prompting: {
    value:
      "Not observable. MCPJam emulation presents the event as untrusted data under the user's standing instruction.",
    provenance: policy(
      "ChatGPT's internal prompting is not observable; this is MCPJam's own."
    ),
  },
  pollFloorMs: {
    value: 1000,
    provenance: policy("Poll is unsupported by ChatGPT; the draft floor applies."),
  },
};

export const EVENTS_PROFILES: Record<EventsProfileId, EventsProfile> = {
  [DRAFT_PROFILE_ID]: DRAFT_PROFILE,
  [CHATGPT_PROFILE_ID]: CHATGPT_PROFILE,
};

export function getEventsProfile(id: EventsProfileId): EventsProfile {
  return EVENTS_PROFILES[id];
}

export function isEventsProfileId(value: unknown): value is EventsProfileId {
  return value === DRAFT_PROFILE_ID || value === CHATGPT_PROFILE_ID;
}

/**
 * Every fact of a profile with its provenance, flattened for display and
 * for the phase-0 exit gate ("every field is tagged").
 */
export function listProfileFacts(
  profile: EventsProfile
): Array<{ field: string; value: unknown; provenance: ProfileProvenance }> {
  return Object.entries(profile)
    .filter(
      ([, value]) =>
        typeof value === "object" && value !== null && "provenance" in value
    )
    .map(([field, fact]) => ({
      field,
      value: (fact as ProfileFact<unknown>).value,
      provenance: (fact as ProfileFact<unknown>).provenance,
    }));
}

/** Delivery modes a profile lets MCPJam use against a server's advertised list. */
export function usableDeliveryModes(
  profile: EventsProfile,
  advertised: readonly string[]
): DeliveryMode[] {
  return profile.deliveryModes.value.filter((mode) => advertised.includes(mode));
}

/**
 * The draft's client preference order (Delivery Mode Selection): webhook when
 * a receiver is configured, then push when the transport can stream, then
 * poll. Returns `undefined` for the draft's `NoCompatibleDeliveryMode`.
 */
export function selectDeliveryMode(args: {
  profile: EventsProfile;
  advertised: readonly string[];
  webhookReceiverAvailable: boolean;
  pushAvailable: boolean;
  forced?: DeliveryMode;
}): DeliveryMode | undefined {
  const usable = usableDeliveryModes(args.profile, args.advertised);
  if (args.forced) return usable.includes(args.forced) ? args.forced : undefined;
  if (args.webhookReceiverAvailable && usable.includes("webhook")) return "webhook";
  if (args.pushAvailable && usable.includes("push")) return "push";
  if (usable.includes("poll")) return "poll";
  return undefined;
}
