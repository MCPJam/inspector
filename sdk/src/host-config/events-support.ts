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
 *  - Absent: the host style's default, so older hosts need no migration.
 *  - No host at all is MCPJam (built-in), which accepts every mode.
 */

export const MCPJAM_EVENTS_EXTENSION_ID = "com.mcpjam/events" as const;

export type EventDeliveryMode = "poll" | "push" | "webhook";
export const EVENT_DELIVERY_MODES: readonly EventDeliveryMode[] = [
  "poll",
  "push",
  "webhook",
];

/** Host styles whose real client receives events, and how. */
export const HOST_STYLE_EVENT_DELIVERY_MODES: Readonly<
  Record<string, readonly EventDeliveryMode[]>
> = {
  chatgpt: ["webhook"],
  mcpjam: EVENT_DELIVERY_MODES,
};

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
  hostStyle?: string | null;
  mcpProfile?: unknown;
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

/** The saved setting, without applying the style default. */
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

/** The style default for a host with no saved setting. */
export function hostStyleEventDeliveryModes(
  hostStyle: string | null | undefined
): EventDeliveryMode[] {
  // Own entries only: a style such as `constructor` must not reach an
  // inherited Object member.
  return typeof hostStyle === "string" &&
    Object.prototype.hasOwnProperty.call(
      HOST_STYLE_EVENT_DELIVERY_MODES,
      hostStyle
    )
    ? [...HOST_STYLE_EVENT_DELIVERY_MODES[hostStyle]]
    : [];
}

/**
 * The delivery modes a host receives events by. `null` / `undefined` is
 * MCPJam (built-in): every mode.
 */
export function resolveHostEventDeliveryModes(
  host: EventsSupportHost | null | undefined
): EventDeliveryMode[] {
  if (!host) return [...EVENT_DELIVERY_MODES];
  const setting = readEventsHostSetting(host);
  if (setting.kind === "valid") return setting.modes;
  if (setting.kind === "invalid") return [];
  return hostStyleEventDeliveryModes(host.hostStyle);
}

/**
 * A host with `modes` saved explicitly. `[]` saves `{}` — "receives no
 * events" — which differs from {@link clearEventsHostSetting} (back to the
 * style default).
 */
export function setEventsHostSetting<T extends EventsSupportHost>(
  host: T,
  modes: readonly EventDeliveryMode[]
): T {
  const profile = isRecord(host.mcpProfile) ? host.mcpProfile : {};
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

/**
 * A host with the setting removed, back to the style default. Leaves no
 * empty containers behind: host configs are content-addressed, so residue
 * would mint a new config row for an unchanged host.
 */
export function clearEventsHostSetting<T extends EventsSupportHost>(
  host: T
): T {
  const profile = host.mcpProfile;
  if (!isRecord(profile) || !isRecord(profile.extensions)) return host;
  if (
    !Object.prototype.hasOwnProperty.call(
      profile.extensions,
      MCPJAM_EVENTS_EXTENSION_ID
    )
  )
    return host;
  const { [MCPJAM_EVENTS_EXTENSION_ID]: _removed, ...extensions } =
    profile.extensions;
  const { extensions: _dropped, ...profileRest } = profile;
  const nextProfile =
    Object.keys(extensions).length > 0
      ? { ...profileRest, extensions }
      : profileRest;
  if (Object.keys(nextProfile).length > 0) {
    return { ...host, mcpProfile: nextProfile };
  }
  const { mcpProfile: _removedProfile, ...rest } = host;
  return rest as T;
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

/**
 * Why a single mode can't be used, in words a user can act on, or null when
 * it can. `hostName` names the host in the message.
 */
export function describeModeRefusal(
  mode: EventDeliveryMode,
  result: SubscribableModes,
  hostName: string
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
        ? `${hostName} doesn't receive events. Turn on a delivery mode in its Protocol settings, or pick another client.`
        : `${hostName} doesn't receive events by ${mode}. Turn it on in its Protocol settings, or pick another client.`;
  }
}

/**
 * Why nothing can be subscribed, or null when some mode can. The host is
 * named first when it receives no events at all, since that is the fix the
 * user most likely needs.
 */
export function describeNoSubscribableMode(
  result: SubscribableModes,
  hostName: string
): string | null {
  if (result.modes.length > 0) return null;
  if (result.hostModes.length === 0) {
    return `${hostName} doesn't receive events. Turn on a delivery mode in its Protocol settings, or pick another client.`;
  }
  const accepted = result.hostModes.join(" or ");
  if (result.hostModes.every((mode) => result.refused[mode] === "runtime")) {
    return `${hostName} receives events only by ${accepted}, which hosted subscriptions can't use yet. Subscribe from the local app, or pick another client.`;
  }
  return `${hostName} receives events by ${accepted}, and the server doesn't offer that for this event. Pick another client.`;
}
