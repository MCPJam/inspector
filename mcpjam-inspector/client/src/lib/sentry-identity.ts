import * as Sentry from "@sentry/react";

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
export type SentryActorKind = "signedIn" | "guest";

export interface SentryActor {
  kind: SentryActorKind;
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

/**
 * Point the scope at the current actor, or clear it.
 *
 * Guests are identified too, not blanked. An anonymous crash is the one you
 * cannot chase, and a guest id is no more identifying than the cookie the
 * browser is already carrying — while `actor_kind` keeps the two populations
 * separable in search.
 *
 * The email rides along for signed-in users only, and only because they signed
 * in: `sendDefaultPii: false` (see `shared/sentry-config.ts`) governs what the
 * SDK collects *automatically* — IP, headers, cookies — and does not suppress
 * fields set here. That split is the intended posture: nothing incidental, one
 * field on purpose.
 */
export function setSentryActor(actor: SentryActor | null): void {
  if (!actor) {
    Sentry.setUser(null);
    Sentry.setTag("actor_kind", undefined);
    return;
  }

  Sentry.setUser({
    id: actor.id,
    // `username` as well as `email`: Sentry's issue list renders whichever it
    // finds first, and without it a user reads as a bare opaque id in exactly
    // the view where you are trying to recognize someone.
    ...(actor.email ? { email: actor.email, username: actor.email } : {}),
    ...(actor.name ? { name: actor.name } : {}),
  });
  Sentry.setTag("actor_kind", actor.kind);
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
  organizationId: string | null | undefined
): void {
  const trimmed = organizationId?.trim();
  Sentry.setTag("organization_id", trimmed ? trimmed : undefined);
}
