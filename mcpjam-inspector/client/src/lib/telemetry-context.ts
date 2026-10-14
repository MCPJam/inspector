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
import { setTelemetryTransportPolicyReader } from "./telemetry-transport-policy";
import {
  encodeCaptureContext,
  captureContextKey,
  CONSERVATIVE_TELEMETRY_POLICY,
  TELEMETRY_CONTEXT_PROPERTY,
  type TelemetryCaptureContext,
  type TelemetryIdentity,
  type TelemetryPolicy,
} from "../../../shared/telemetry-privacy";
import {
  currentSessionPrivacy,
  isCredentialBearingPath,
  replayFramesToSend,
} from "./session-privacy";


// ── Identity grant ─────────────────────────────────────────────────────

let currentActorId: string | null = null;
/** The backend's identity answer for `currentActorId`; none yet = undefined. */
let identityAnswer: TelemetryIdentity | undefined;
let contentAnswer:
  | { actor: string; context: string; content: TelemetryPolicy["content"] }
  | undefined;
const identityListeners = new Set<() => void>();
let policyUpdateDepth = 0;
let policyNotificationPending = false;

function notifyIdentity(): void {
  if (policyUpdateDepth > 0) {
    policyNotificationPending = true;
    return;
  }
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
  contentAnswer = undefined;
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
  return telemetryIdentityFor(actorId) === "full" && contentAllowed();
}

/** Policy changes notify recorders even when only the visible context changes. */
export function subscribeTelemetryPolicy(listener: () => void): () => void {
  identityListeners.add(listener);
  return () => identityListeners.delete(listener);
}

// ── Capture context ────────────────────────────────────────────────────

let contextIds: {
  projectIds: string[];
  organizationIds: string[];
  sharedLink?: boolean;
} = {
  projectIds: [],
  organizationIds: [],
};

/** The project and organizations in view. Set by `App`. */
export function setTelemetryCaptureContext(ids: {
  projectIds: ReadonlyArray<string | null | undefined>;
  organizationIds: ReadonlyArray<string | null | undefined>;
  sharedLink?: boolean;
}): void {
  const previous = captureContextKey(contextIds);
  const wasShared = Boolean(contextIds.sharedLink);
  contextIds = {
    sharedLink: ids.sharedLink,
    projectIds: ids.projectIds.filter((id): id is string => !!id),
    organizationIds: ids.organizationIds.filter((id): id is string => !!id),
  };
  if (
    previous !== captureContextKey(contextIds) ||
    wasShared !== Boolean(contextIds.sharedLink)
  ) {
    contentAnswer = undefined;
    notifyIdentity();
  }
}

/** Bind the backend answer to the current actor and visible context. */
export function setTelemetryContentPolicy(
  actor: string | null,
  content: TelemetryPolicy["content"] | undefined,
): void {
  const next =
    actor && actor === currentActorId && content
      ? { actor, context: captureContextKey(contextIds), content }
      : undefined;
  if (
    next?.actor === contentAnswer?.actor &&
    next?.context === contentAnswer?.context &&
    next?.content === contentAnswer?.content
  ) {
    return;
  }
  contentAnswer = next;
  notifyIdentity();
}

/** Apply a fresh context and its validated answer before notifying recorders. */
export function setTelemetryCaptureContextAndContent(
  ids: Parameters<typeof setTelemetryCaptureContext>[0],
  actor: string | null,
  content: TelemetryPolicy["content"] | undefined,
): void {
  policyUpdateDepth += 1;
  try {
    setTelemetryCaptureContext(ids);
    setTelemetryContentPolicy(actor, content);
  } finally {
    policyUpdateDepth -= 1;
    if (policyUpdateDepth === 0 && policyNotificationPending) {
      policyNotificationPending = false;
      notifyIdentity();
    }
  }
}

function contentAllowed(): boolean {
  return Boolean(
    contentAnswer?.actor === currentActorId &&
    contentAnswer?.content === "full" &&
    contentAnswer.context === captureContextKey(contextIds) &&
    typeof window !== "undefined" &&
    !window.isElectron &&
    !contextIds.sharedLink &&
    !isCredentialBearingPath() &&
    contextIds.projectIds.length + contextIds.organizationIds.length > 0
  );
}

/** Content permission is independent of replay's startup delay and surface. */
export function currentTelemetryCaptureContext(): TelemetryCaptureContext {
  const full = contentAllowed();
  const recording = currentSessionPrivacy();
  return {
    projectIds: [...contextIds.projectIds],
    organizationIds: [...contextIds.organizationIds],
    policy: full
      ? {
          recording:
            recording === "full" || recording === "masked" ? recording : "off",
          identity: telemetryNamesAllowed() ? "full" : "id_only",
          content: "full",
        }
      : { ...CONSERVATIVE_TELEMETRY_POLICY },
  };
}

// ── PostHog ────────────────────────────────────────────────────────────

interface PostHogCaptureEvent {
  event?: string;
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
}

/**
 * posthog-js `before_send`: stamp the event with the context it was captured
 * under, keep names off it unless the current actor is granted them, and keep
 * the relay bearer out of replay data. Drops only replay frames recorded
 * under a laxer profile than the one in effect (`replayFramesToSend`); never
 * throws.
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
    // posthog-js records its config, the relay bearer in `request_headers`
    // included, into the replay as `$posthog_config`. The relay strips it
    // again.
    if (event.event === "$snapshot" && "$snapshot_data" in properties) {
      const frames = replayFramesToSend(properties.$snapshot_data);
      if (frames === null) return null as T;
      properties.$snapshot_data = frames;
    }
    return { ...event, properties } as T;
  } catch {
    return null as T;
  }
}

setTelemetryTransportPolicyReader(
  () => currentTelemetryCaptureContext().policy.content,
);
