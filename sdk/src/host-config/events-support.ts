/**
 * A host's MCP Events support, and which delivery modes a subscription may
 * use: `hostConfig.mcpProfile.extensions["com.mcpjam/events"]`.
 *
 * MCPJam policy, never advertised (an Events client declares nothing on the
 * wire), like `com.mcpjam/tasks`. The backend mirrors these rules
 * (`hostEventDeliveryModes` in `convex/lib/eventRegistry.ts`) and enforces
 * them:
 *
 *  - A mode counts only when `true`; `{}` is "receives no events".
 *  - A malformed value is "no modes": it never widens what a host accepts.
 *  - Absent is "no modes" too. Templates save the setting, and saved clients
 *    made before it existed were backfilled.
 *  - A vendor harness (`agentLoop` or `harness`) is "no modes": the vendor's
 *    own client decides, and none of them receives MCP Events.
 *  - No host at all is MCPJam (built-in), which accepts every mode.
 *
 * The client's MCP Apps style plays no part in any of this.
 */

export const MCPJAM_EVENTS_EXTENSION_ID = "com.mcpjam/events" as const;

export type EventDeliveryMode = "poll" | "push" | "webhook";
export const EVENT_DELIVERY_MODES: readonly EventDeliveryMode[] = [
  "poll",
  "push",
  "webhook",
];

/** Where a subscription is kept refreshed and its events received. */
export type EventsRuntime = "hosted" | "local";

/** What each runtime can deliver: hosted push is deferred. Triggers are hosted. */
export const RUNTIME_EVENT_DELIVERY_MODES: Readonly<
  Record<EventsRuntime, readonly EventDeliveryMode[]>
> = {
  hosted: ["poll", "webhook"],
  local: EVENT_DELIVERY_MODES,
};

/** The parts of a host config this module reads and writes. */
export interface EventsSupportHost {
  mcpProfile?: unknown;
  /** A vendor harness that runs the client's agent loop (see `effectiveHarnessId`). */
  harness?: string | null;
  agentLoop?: string | null;
}

export type EventsHostSetting =
  | { kind: "unset" }
  | { kind: "valid"; modes: EventDeliveryMode[] }
  | { kind: "invalid" };

/** A plain JSON object, so an exotic value fails closed (see tasks-policy). */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isEventDeliveryMode(
  value: unknown
): value is EventDeliveryMode {
  return (EVENT_DELIVERY_MODES as readonly unknown[]).includes(value);
}

/** The saved setting as stored, before the harness rule. */
export function readEventsHostSetting(
  host: EventsSupportHost | null | undefined
): EventsHostSetting {
  const mcpProfile = host?.mcpProfile;
  if (mcpProfile === undefined || mcpProfile === null) return { kind: "unset" };
  if (!isRecord(mcpProfile)) return { kind: "invalid" };
  const extensions = mcpProfile.extensions;
  if (extensions === undefined) return { kind: "unset" };
  if (!isRecord(extensions)) return { kind: "invalid" };
  if (
    !Object.prototype.hasOwnProperty.call(
      extensions,
      MCPJAM_EVENTS_EXTENSION_ID
    )
  )
    return { kind: "unset" };
  const entry = extensions[MCPJAM_EVENTS_EXTENSION_ID];
  if (!isRecord(entry)) return { kind: "invalid" };
  for (const [key, value] of Object.entries(entry)) {
    if (!isEventDeliveryMode(key) || typeof value !== "boolean") {
      return { kind: "invalid" };
    }
  }
  return {
    kind: "valid",
    modes: EVENT_DELIVERY_MODES.filter((mode) => entry[mode] === true),
  };
}

/**
 * The delivery modes a host receives events by. `null` / `undefined` is
 * MCPJam (built-in): every mode. A vendor harness, an absent setting and an
 * unreadable one all receive none.
 */
export function resolveHostEventDeliveryModes(
  host: EventsSupportHost | null | undefined
): EventDeliveryMode[] {
  if (!host) return [...EVENT_DELIVERY_MODES];
  if (host.agentLoop ?? host.harness) return [];
  const setting = readEventsHostSetting(host);
  return setting.kind === "valid" ? setting.modes : [];
}

/** A host with `modes` saved explicitly. `[]` saves `{}`: "receives no events". */
export function setEventsHostSetting<T extends EventsSupportHost>(
  host: T,
  modes: readonly EventDeliveryMode[]
): T {
  // A new profile needs its version, or the canonicalizer refuses it.
  const profile = isRecord(host.mcpProfile)
    ? host.mcpProfile
    : { profileVersion: 1 };
  const extensions = isRecord(profile.extensions) ? profile.extensions : {};
  const entry: Partial<Record<EventDeliveryMode, true>> = {};
  for (const mode of EVENT_DELIVERY_MODES) {
    if (modes.includes(mode)) entry[mode] = true;
  }
  return {
    ...host,
    mcpProfile: {
      ...profile,
      extensions: { ...extensions, [MCPJAM_EVENTS_EXTENSION_ID]: entry },
    },
  };
}

/** Which side ruled a mode out. */
export type EventModeRefusal = "runtime" | "event" | "host";

export interface SubscribableModes {
  /** Modes a subscription may use, in {@link EVENT_DELIVERY_MODES} order. */
  modes: EventDeliveryMode[];
  /** The first side that refused each other mode (runtime, then event, then host). */
  refused: Partial<Record<EventDeliveryMode, EventModeRefusal>>;
  /** What the host accepts on its own. */
  hostModes: EventDeliveryMode[];
}

/**
 * The modes a subscription may use: accepted by the runtime, offered by the
 * server for this event (when known), and received by the host. `host: null`
 * is MCPJam (built-in).
 */
export function subscribableModes(args: {
  host: EventsSupportHost | null;
  /**
   * The host's modes when they were already resolved elsewhere (a request
   * names the host by id and its modes); takes precedence over `host`.
   */
  hostModes?: readonly EventDeliveryMode[];
  eventModes?: readonly string[];
  runtime: EventsRuntime;
}): SubscribableModes {
  const hostModes = args.hostModes
    ? EVENT_DELIVERY_MODES.filter((mode) => args.hostModes!.includes(mode))
    : resolveHostEventDeliveryModes(args.host);
  const modes: EventDeliveryMode[] = [];
  const refused: SubscribableModes["refused"] = {};
  for (const mode of EVENT_DELIVERY_MODES) {
    if (!RUNTIME_EVENT_DELIVERY_MODES[args.runtime].includes(mode)) {
      refused[mode] = "runtime";
    } else if (args.eventModes && !args.eventModes.includes(mode)) {
      refused[mode] = "event";
    } else if (!hostModes.includes(mode)) {
      refused[mode] = "host";
    } else {
      modes.push(mode);
    }
  }
  return { modes, refused, hostModes };
}

/** Why a host receives no events at all, naming the harness that runs it. */
function describeNoHostModes(hostName: string, harnessName?: string): string {
  return harnessName
    ? `${hostName} runs on ${harnessName}, which doesn't receive MCP Events. Pick another client.`
    : `${hostName} doesn't receive events. Turn on a delivery mode in the client's Events tab, or pick another client.`;
}

/**
 * Why a single mode can't be used, in words a user can act on, or null when
 * it can. `hostName` names the host in the message, and `harnessName` the
 * vendor harness that runs it, when one does.
 */
export function describeModeRefusal(
  mode: EventDeliveryMode,
  result: SubscribableModes,
  hostName: string,
  harnessName?: string
): string | null {
  switch (result.refused[mode]) {
    case undefined:
      return null;
    case "runtime":
      return `Hosted subscriptions can't use ${mode} yet. Use webhook or poll, or subscribe from the local app.`;
    case "event":
      return `The server doesn't offer ${mode} delivery for this event.`;
    case "host":
      return result.hostModes.length === 0
        ? describeNoHostModes(hostName, harnessName)
        : `${hostName} doesn't receive events by ${mode}. Turn it on in the client's Events tab, or pick another client.`;
  }
}

/**
 * Why nothing can be subscribed, or null when some mode can. The host is
 * named first when it receives no events at all, since that is the fix the
 * user most likely needs.
 */
export function describeNoSubscribableMode(
  result: SubscribableModes,
  hostName: string,
  harnessName?: string
): string | null {
  if (result.modes.length > 0) return null;
  if (result.hostModes.length === 0) {
    return describeNoHostModes(hostName, harnessName);
  }
  const accepted = result.hostModes.join(" or ");
  if (result.hostModes.every((mode) => result.refused[mode] === "runtime")) {
    return `${hostName} receives events only by ${accepted}, which hosted subscriptions can't use yet. Subscribe from the local app, or pick another client.`;
  }
  return `${hostName} receives events by ${accepted}, and the server doesn't offer that for this event. Pick another client.`;
}
