/**
 * Swarm audience-description limit, shared by the create flow's textarea and
 * the route schemas that accept the same text so the two can never drift.
 *
 * One number for both places the Describe step's text lands: the persona /
 * journey generation body (`description`) and the swarm row it is saved on.
 * Sized for pasted user research covering several personas — 2,000 was not
 * enough for three.
 *
 * The SDK's platform operations (and so the CLI) carry the same value as
 * `SWARM_DESCRIPTION_MAX_CHARS` in `sdk/src/platform/operations.ts`; the
 * backend enforces its own copy. Change all three together.
 */
export const SWARM_DESCRIPTION_MAX_CHARS = 10_000;
