/**
 * What a chat surface's SERVICE TOKEN may reach on `/api/v1`.
 *
 * Slack and Discord each carry a bot-scoped credential (`slk_`, `dsc_`) that
 * names the BOT, not a person: the acting user is resolved from headers and
 * the server mints a delegated token for them. That makes the token itself
 * low-privilege — but only as long as the paths it can reach are the ones the
 * surface actually drives. An allowlist is the whole control.
 *
 * The two surfaces had their own copies, and the copies had already diverged:
 * Slack's carried an entry for a retired button's shim that Discord never had,
 * and there was no way to see that at a glance because the lists lived in
 * different files with different comments. This module holds the SHARED BASE;
 * each surface composes it with its own explicitly-declared deltas, and a
 * parity test pins both halves. The point is not that the lists must be
 * identical — it is that every difference is written down as a difference.
 *
 * Patterns match the FULL request path including the `/api/v1` prefix, and are
 * anchored at both ends. An unanchored pattern would match a longer path with
 * the allowed one as a prefix, which is how allowlists usually fail.
 */

/**
 * Reachable by every chat surface's service token.
 *
 * Each entry has to answer: what does the bot do that needs this, and what is
 * the worst a compromised bot token achieves with it? "The surface calls it"
 * is a reason; "it seemed harmless" is not.
 */
export const SURFACE_ALLOWED_PATHS_BASE: ReadonlyArray<RegExp> = [
  // The agent turn itself. The reason this is safe with a bot credential is
  // the reason the whole design works: the token names the bot, the acting
  // user comes from the headers, and the server re-checks THEIR membership.
  /^\/api\/v1\/projects\/[^/]+\/agent$/,

  // Project list, for resolving a name to an id when a user names one.
  /^\/api\/v1\/projects$/,

  // Executing an action a human approved. Safe for the same reason the agent
  // turn is: the clicker named in the headers is who the execution runs as.
  /^\/api\/v1\/projects\/[^/]+\/proposed-actions\/[^/]+\/execute$/,

  // Run status, for the watcher that edits a status message in place.
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+$/,

  // Run EVIDENCE — screenshots posted when a watched run FAILS.
  //
  // Two entries because steps are ITERATION-scoped: the bot lists a run's
  // iterations, then fetches bounded step pages per iteration. Both are reads
  // of a run the acting user can already see (the delegated JWT enforces
  // that), and neither can start or change anything.
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations$/,
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations\/[^/]+\/steps$/,
];

/** A surface-specific addition, with the reason it is not in the base. */
export type AllowedPathDelta = { pattern: RegExp; reason: string };

/**
 * Slack's extras.
 *
 * ONE entry, and it is a liability rather than a feature: `POST /eval-runs`
 * CREATES a run, which is exactly the kind of thing the proposal/approval flow
 * exists to keep off a bot credential. It survives only for the retired
 * "Run it" button, whose handler is still a shim for buttons on messages
 * posted before the switch to proposals.
 *
 * Removal is coupled to the blocked MIGRATION.md Phase 4, so it is documented
 * here rather than quietly carried: when that unblocks, this entry and the
 * shim go together.
 */
export const SLACK_ALLOWED_PATH_DELTAS: ReadonlyArray<AllowedPathDelta> = [
  {
    pattern: /^\/api\/v1\/projects\/[^/]+\/eval-runs$/,
    reason:
      "RETIRED Run-it button shim. POST creates a run — a write a bot credential should not reach — kept only for buttons on messages posted before proposals. Removed together with the shim when MIGRATION.md Phase 4 unblocks.",
  },
];

/**
 * Discord's extras.
 *
 * `/api/surface-link/session` mints the connect link a user follows to link
 * their account. It is on this list and not the base because it is not an
 * `/api/v1` route at all — Slack links accounts through its Home tab instead,
 * so it has no equivalent need.
 */
export const SURFACE_ALLOWED_PATH_DELTAS: ReadonlyArray<AllowedPathDelta> = [
  {
    pattern: /^\/api\/surface-link\/session$/,
    reason:
      "Mints the connect link a Discord user follows to link their MCPJam account. Not an /api/v1 route; Slack links accounts through its Home tab and needs no equivalent.",
  },
];

/** Compose the base with a surface's deltas into one matcher list. */
export function composeAllowedPaths(
  deltas: ReadonlyArray<AllowedPathDelta>
): ReadonlyArray<RegExp> {
  return [
    ...SURFACE_ALLOWED_PATHS_BASE,
    ...deltas.map((delta) => delta.pattern),
  ];
}
