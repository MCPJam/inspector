import * as Sentry from "@sentry/react";
import {
  isSentryId,
  type SentryActor as SharedSentryActor,
} from "../../../shared/sentry-identity";
import {
  subscribeTelemetryIdentity,
  telemetryNamesAllowed,
} from "./telemetry-context";

export function desktopSentryFallback() {
  const id =
    typeof window === "undefined"
      ? undefined
      : window.electronAPI?.sentry?.installationId;
  return isSentryId(id) && id.startsWith("installation:")
    ? { user: { id }, tags: { actor_kind: "installation" } }
    : undefined;
}

/**
 * The one place the Sentry scope learns who is using the app.
 *
 * Everything else in the client *reports* errors; nothing else sets identity.
 * Keeping it to a single writer is what makes the guarantee checkable: a scope
 * carries the current actor or none, never a stale one, because every
 * transition — sign-in, sign-out, guest rotation — runs through
 * `setSentryActor`, and `Sentry.setUser` replaces the user object wholesale.
 */

/**
 * Actor kinds, spelled exactly as the server spells them (`ExecutionActorKind`
 * in `server/utils/execution-scope.ts`, `authType` in the request logs). A
 * client Sentry issue and the server log line for the same request should be
 * filterable by the same word rather than by two dialects of it.
 */
export type SentryActorKind = SharedSentryActor["kind"];

export interface SentryActor extends SharedSentryActor {
  /**
   * The same key PostHog identifies on (`useActorKey`): the WorkOS user id when
   * signed in, the cookie-backed guest id otherwise. Shared deliberately — it
   * is what lets a Sentry issue be pivoted into the PostHog funnel for the same
   * actor without maintaining a lookup table between the two products.
   */
  id: string;
  email?: string;
  name?: string;
}

let lastSentryActor: SentryActor | null = null;
/** Whether the scope currently names `lastSentryActor`. */
let lastSentryActorNamed = false;

/**
 * Point the scope at the current actor, or clear it.
 *
 * Guests are identified too, not blanked. An anonymous crash is the one you
 * cannot chase, and a guest id is no more identifying than the cookie the
 * browser is already carrying — while `actor_kind` keeps the two populations
 * separable in search.
 *
 * Id-only until proven otherwise. The email and name ride along only for a
 * signed-in actor the backend has affirmatively cleared for this actor
 * (`telemetryNamesAllowed`, lib/telemetry-context.ts): not during boot, not
 * while the answer is pending, not after an account switch until the new
 * actor's answer arrives, and never for a member of an organization with
 * enterprise privacy. `sendDefaultPii: false` (see `shared/sentry-config.ts`)
 * governs what the SDK collects *automatically* and does not suppress fields
 * set here, so this check is what keeps them out; `filterSentryEventIdentity`
 * enforces it again on every outbound event.
 */
export function setSentryActor(actor: SentryActor | null): void {
  lastSentryActor = actor;
  try {
    window.electronAPI?.sentry?.setActor(
      actor ? { id: actor.id, kind: actor.kind } : null,
    );
  } catch {
    /* Telemetry must not interrupt sign-in or sign-out. */
  }
  if (!actor) {
    const fallback = desktopSentryFallback();
    Sentry.setUser(fallback?.user ?? null);
    Sentry.setTag("actor_kind", fallback?.tags.actor_kind);
    return;
  }

  const named = actor.kind === "signedIn" && telemetryNamesAllowed(actor.id);
  lastSentryActorNamed = named;
  Sentry.setUser({
    id: actor.id,
    // `username` as well as `email`: Sentry's issue list renders whichever it
    // finds first, and without it a user reads as a bare opaque id in exactly
    // the view where you are trying to recognize someone.
    ...(actor.email && named
      ? { email: actor.email, username: actor.email }
      : {}),
    ...(actor.name && named ? { name: actor.name } : {}),
  });
  Sentry.setTag("actor_kind", actor.kind);
}

// The grant can change without the actor changing (the backend's answer
// arriving, a membership reload). Re-apply the current actor each time, still
// through `setSentryActor`, so this module stays the only writer of identity
// and the email leaves the scope the moment the grant does.
subscribeTelemetryIdentity(() => {
  const actor = lastSentryActor;
  if (!actor) return;
  const named = actor.kind === "signedIn" && telemetryNamesAllowed(actor.id);
  if (named !== lastSentryActorNamed) setSentryActor(actor);
});

/** The `user` fields that name a person rather than identify an account. */
const NAMING_USER_FIELDS = ["email", "username", "name", "ip_address", "geo"];

/**
 * The outbound boundary: strip naming fields from an event's `user` unless
 * names are allowed. `allowNames` is the stricter of the grant when the event
 * was captured and the grant now (see `sentry.ts`), so an event captured
 * while id-only stays id-only even if it leaves after a grant arrives.
 * Mutates and returns the event; never throws.
 */
export function filterSentryEventIdentity<T extends { user?: unknown }>(
  event: T,
  allowNames: boolean,
): T {
  try {
    if (allowNames) return event;
    const user = event.user;
    if (!user || typeof user !== "object") return event;
    const kept = { ...(user as Record<string, unknown>) };
    for (const field of NAMING_USER_FIELDS) delete kept[field];
    event.user = kept;
  } catch {
    // A failed filter must not drop the event; the scope was id-only anyway
    // unless a grant was in force.
  }
  return event;
}

/**
 * Tag the scope with the active organization.
 *
 * A tag rather than a context: for a B2B product the first triage question is
 * "which account", and only tags are indexed for search, filtering, and alert
 * conditions. Mirrors `usePostHogOrgContext`'s `organization_id` register so
 * the two sinks agree on the name.
 *
 * An org id is either a real id or absent, so a blank one clears rather than
 * tags: `organization_id:""` is a searchable value that matches nothing and
 * reads, in a filter dropdown, as an org whose name failed to load.
 */
export function setSentryOrganization(
  organizationId: string | null | undefined,
): void {
  const trimmed = organizationId?.trim();
  Sentry.setTag("organization_id", trimmed ? trimmed : undefined);
}
