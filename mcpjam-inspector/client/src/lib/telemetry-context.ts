/**
 * What every captured telemetry event is captured UNDER: the contexts in view
 * and the policy in effect at that moment, and whether the current actor may
 * be named.
 *
 * Two halves, both module state so the SDK hooks (PostHog `before_send`,
 * Sentry's event hooks) can read them synchronously at capture time:
 *
 *   - The capture context. `setTelemetryCaptureContext` is fed the project and
 *     organizations in view; `stampPostHogEvent` writes them, with the level
 *     and identity mode in effect, onto each PostHog event as it is captured.
 *     The relay checks the stamp against the backend and removes it. Stamped
 *     at capture, because posthog-js sends later, in batches: navigating to a
 *     laxer page must not relax events captured on the stricter one.
 *
 *   - The identity grant. Names and email are allowed only after an
 *     affirmative `identity: "full"` answer from the backend for the CURRENT
 *     actor. Any actor change clears it at once (`setTelemetryActor`), an
 *     answer for any other actor is ignored (`setTelemetryIdentity`), and a
 *     membership reload clears it until the next answer
 *     (`resetTelemetryIdentity`). Sentry's scope (`sentry-identity.ts`) and
 *     PostHog's identify both read it.
 */
import {
  encodeCaptureContext,
  IDENTIFYING_PERSON_PROPERTIES,
  TELEMETRY_CONTEXT_PROPERTY,
  type TelemetryCaptureContext,
  type TelemetryIdentity,
} from "../../../shared/telemetry-privacy";
import { currentSessionPrivacy } from "./session-privacy";

// ── Identity grant ─────────────────────────────────────────────────────

let currentActorId: string | null = null;
/** The backend's identity answer for `currentActorId`; none yet = undefined. */
let identityAnswer: TelemetryIdentity | undefined;
const identityListeners = new Set<() => void>();

function notifyIdentity(): void {
  for (const listener of identityListeners) {
    try {
      listener();
    } catch {
      // A listener's failure must not stop the others from re-applying.
    }
  }
}

/** The actor telemetry currently attributes to. */
export function currentTelemetryActor(): string | null {
  return currentActorId;
}

/**
 * The actor changed (sign-in, sign-out, a different account, a new guest).
 * Clears the identity grant immediately: the new actor is id-only until the
 * backend answers for them.
 */
export function setTelemetryActor(actorId: string | null): void {
  if (actorId === currentActorId) return;
  currentActorId = actorId;
  identityAnswer = undefined;
  notifyIdentity();
}

/**
 * The backend's identity mode, for the actor it was resolved for. Ignored
 * unless that is the current actor, so a late answer for a previous actor
 * can never name the next one.
 */
export function setTelemetryIdentity(
  actorId: string | null,
  identity: TelemetryIdentity,
): void {
  if (actorId !== currentActorId) return;
  const next = actorId === null ? undefined : identity;
  if (next === identityAnswer) return;
  identityAnswer = next;
  notifyIdentity();
}

/** Back to id-only until the next answer, e.g. after a membership reload. */
export function resetTelemetryIdentity(): void {
  if (identityAnswer === undefined) return;
  identityAnswer = undefined;
  notifyIdentity();
}

/**
 * The identity answer held for `actorId`: `"full"`, `"id_only"`, or
 * `undefined` when there is none for that actor.
 */
export function telemetryIdentityFor(
  actorId: string | null,
): TelemetryIdentity | undefined {
  return actorId !== null && actorId === currentActorId
    ? identityAnswer
    : undefined;
}

/** Whether name and email may be sent for `actorId` (default: current). */
export function telemetryNamesAllowed(
  actorId: string | null = currentActorId,
): boolean {
  return telemetryIdentityFor(actorId) === "full";
}

export function subscribeTelemetryIdentity(listener: () => void): () => void {
  identityListeners.add(listener);
  return () => identityListeners.delete(listener);
}

// ── Capture context ────────────────────────────────────────────────────

let contextIds: { projectIds: string[]; organizationIds: string[] } = {
  projectIds: [],
  organizationIds: [],
};

/** The project and organizations in view. Set by `App`. */
export function setTelemetryCaptureContext(ids: {
  projectIds: ReadonlyArray<string | null | undefined>;
  organizationIds: ReadonlyArray<string | null | undefined>;
}): void {
  contextIds = {
    projectIds: ids.projectIds.filter((id): id is string => !!id),
    organizationIds: ids.organizationIds.filter((id): id is string => !!id),
  };
}

/** The context an event captured right now is captured under. */
export function currentTelemetryCaptureContext(): TelemetryCaptureContext {
  return {
    projectIds: [...contextIds.projectIds],
    organizationIds: [...contextIds.organizationIds],
    policy: {
      recording: currentSessionPrivacy() === "full" ? "full" : "masked",
      identity: telemetryNamesAllowed() ? "full" : "id_only",
    },
  };
}

// ── PostHog ────────────────────────────────────────────────────────────

interface PostHogCaptureEvent {
  event?: string;
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
}

function withoutIdentifying(
  props: unknown,
): Record<string, unknown> | undefined {
  if (typeof props !== "object" || props === null) return undefined;
  const out = { ...(props as Record<string, unknown>) };
  for (const key of IDENTIFYING_PERSON_PROPERTIES) delete out[key];
  return out;
}

const REQUEST_HEADER_CONFIG_KEYS = ["request_headers", "xhr_headers"];

/**
 * posthog-js records its whole config into the replay as a `$posthog_config`
 * custom event — including `request_headers`, which carries the bearer the
 * relay authenticates with. The token must never reach PostHog, so it comes
 * out here, as the snapshot is captured. The relay strips it again.
 */
function scrubSnapshotConfig(snapshotData: unknown): unknown {
  if (!Array.isArray(snapshotData)) return snapshotData;
  return snapshotData.map((entry) => {
    const event = entry as {
      type?: unknown;
      data?: { tag?: unknown; payload?: { config?: unknown } };
    };
    if (
      event?.type !== 5 ||
      event.data?.tag !== "$posthog_config" ||
      typeof event.data.payload?.config !== "object" ||
      event.data.payload.config === null
    ) {
      return entry;
    }
    const config = {
      ...(event.data.payload.config as Record<string, unknown>),
    };
    for (const key of REQUEST_HEADER_CONFIG_KEYS) delete config[key];
    return {
      ...event,
      data: { ...event.data, payload: { ...event.data.payload, config } },
    };
  });
}

/**
 * posthog-js `before_send`: stamp the event with the context it was captured
 * under, keep names off it unless the current actor is granted them, and keep
 * the relay bearer out of replay data. Never drops an event and never throws.
 */
export function stampPostHogEvent<T extends PostHogCaptureEvent | null>(
  event: T,
): T {
  if (!event) return event;
  try {
    const context = currentTelemetryCaptureContext();
    const properties: Record<string, unknown> = {
      ...(event.properties ?? {}),
      [TELEMETRY_CONTEXT_PROPERTY]: encodeCaptureContext(context),
    };
    if (event.event === "$snapshot" && "$snapshot_data" in properties) {
      properties.$snapshot_data = scrubSnapshotConfig(
        properties.$snapshot_data,
      );
    }
    const next: PostHogCaptureEvent = { ...event, properties };
    if (context.policy.identity !== "full") {
      if (event.$set) next.$set = withoutIdentifying(event.$set);
      if (event.$set_once) next.$set_once = withoutIdentifying(event.$set_once);
      if (properties.$set)
        properties.$set = withoutIdentifying(properties.$set);
      if (properties.$set_once) {
        properties.$set_once = withoutIdentifying(properties.$set_once);
      }
    }
    return next as T;
  } catch {
    // An event we failed to stamp reaches the relay unstamped, which handles
    // it conservatively. Dropping it here would lose more than it protects.
    return event;
  }
}
