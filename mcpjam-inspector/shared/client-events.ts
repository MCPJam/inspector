/**
 * Every Events question the inspector asks about a client, answered from what
 * the client does: its saved delivery modes and the harness that runs it.
 * Read through the SDK's strict reader, so the Events tab, the Playground's
 * subscriptions and the agent's tools can't disagree.
 *
 * The agent's modes leave out a local webhook: its plain-HTTP receiver needs
 * the user's consent for each subscription, which a model can't give. That
 * matches `pickMode` in the Playground's agent tools.
 */
import {
  EVENT_DELIVERY_MODES,
  RUNTIME_EVENT_DELIVERY_MODES,
  readEventsHostSetting,
  resolveHostEventDeliveryModes,
  type EventDeliveryMode,
  type EventsRuntime,
  type EventsSupportHost,
} from "@mcpjam/sdk/browser";
import { HARNESS_DESCRIPTORS, effectiveHarnessId } from "./harness-descriptors";

/** Why the agent gets no Events tools, in the order the checks run. */
export type ClientEventsAgentToolsReason =
  | "harness"
  | "invalid"
  | "no-modes"
  | "runtime"
  | "local-webhook";

export interface ClientEventsView {
  /** The modes the client receives events by. */
  modes: EventDeliveryMode[];
  /** The saved setting's state. MCPJam (built-in) reads as `valid`. */
  setting: "valid" | "invalid" | "unset";
  /** Whether the modes can be changed here. */
  editable: boolean;
  /** The vendor harness that runs the client, when one does. */
  harness?: { id: string; name: string };
  runtime: EventsRuntime;
  /** `modes` this runtime can deliver. */
  usableModes: EventDeliveryMode[];
  agentTools:
    | { available: true; modes: EventDeliveryMode[] }
    | { available: false; reason: ClientEventsAgentToolsReason };
}

/** The display name of a vendor harness, or its id when it isn't known. */
export function harnessDisplayName(id: string): string {
  return Object.hasOwn(HARNESS_DESCRIPTORS, id)
    ? HARNESS_DESCRIPTORS[id as keyof typeof HARNESS_DESCRIPTORS].displayName
    : id;
}

/**
 * `config: null` is MCPJam (built-in): every mode, nothing to edit, and the
 * agent can subscribe.
 */
export function describeClientEvents(
  config: EventsSupportHost | null,
  opts: { runtime: EventsRuntime; readOnly?: boolean },
): ClientEventsView {
  const runtime = opts.runtime;
  const modes = resolveHostEventDeliveryModes(config);
  const harnessId = effectiveHarnessId(config);
  const harness = harnessId
    ? { id: harnessId, name: harnessDisplayName(harnessId) }
    : undefined;
  const setting = config ? readEventsHostSetting(config).kind : "valid";
  const usableModes = EVENT_DELIVERY_MODES.filter(
    (mode) =>
      modes.includes(mode) &&
      RUNTIME_EVENT_DELIVERY_MODES[runtime].includes(mode),
  );
  const agentModes = usableModes.filter(
    (mode) => runtime === "hosted" || mode !== "webhook",
  );
  const reason: ClientEventsAgentToolsReason | null = harness
    ? "harness"
    : setting === "invalid"
      ? "invalid"
      : modes.length === 0
        ? "no-modes"
        : usableModes.length === 0
          ? "runtime"
          : agentModes.length === 0
            ? "local-webhook"
            : null;
  return {
    modes,
    setting,
    editable: config !== null && !harness && !opts.readOnly,
    ...(harness ? { harness } : {}),
    runtime,
    usableModes,
    agentTools:
      reason === null
        ? { available: true, modes: agentModes }
        : { available: false, reason },
  };
}
