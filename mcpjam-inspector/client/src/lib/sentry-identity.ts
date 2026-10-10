import * as Sentry from "@sentry/react";
import {
  isSentryId,
  type SentryActor as SharedSentryActor,
} from "../../../shared/sentry-identity";

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
}

let lastSentryActor: SentryActor | null = null;
let idOnlyIdentity = false;

/**
 * Point the scope at the current actor, or clear it.
 *
 * Guests are identified too, not blanked. An anonymous crash is the one you
 * cannot chase, and a guest id is no more identifying than the cookie the
 * browser is already carrying — while `actor_kind` keeps the two populations
 * separable in search.
 *
 * The id and nothing else — no email, no name. `sendDefaultPii: false` (see
 * `shared/sentry-config.ts`) only governs what the SDK collects
 * *automatically*; it does not suppress fields set here, so this is where the
 * line is held. The id resolves to a person through WorkOS when someone with
 * access needs it, which is the same thing the server and Electron main send.
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

  Sentry.setUser({ id: actor.id });
  Sentry.setTag("actor_kind", actor.kind);
}

/**
 * Identify by id alone: a member of an organization with enterprise privacy
 * (lib/session-privacy.ts). Identity is already id-only for everyone (see
 * `setSentryActor`), so this only re-applies the current actor; it is kept so
 * the privacy hook has one call site that states the requirement.
 */
export function setSentryIdOnlyIdentity(idOnly: boolean): void {
  if (idOnly === idOnlyIdentity) return;
  idOnlyIdentity = idOnly;
  setSentryActor(lastSentryActor);
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
