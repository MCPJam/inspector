/**
 * Recognising a Swarms GOAL RUN in an approved action's result.
 *
 * Its own module rather than a helper in `app.js` because `app.js` builds a
 * Gateway client at import time — a test that wanted this rule would have to
 * start the bot to reach it, and this rule is exactly the one that has to be
 * right before the API changes what it sends.
 */

/**
 * The permalink resource types a goal run is announced under.
 *
 * `journey_run` is the pre-rename spelling and `goal_run` the canonical one.
 * Both are accepted for as long as the API may emit either, which is decided
 * by the `x-mcpjam-api-vocabulary` negotiation on the other side — not by
 * anything this app can see, so it never stops accepting the old one on its
 * own initiative. They go together at general availability.
 */
export const GOAL_RUN_RESOURCE_TYPES = new Set(["goal_run", "journey_run"]);

/**
 * True when this permalink resource TYPE names a goal run.
 *
 * The TYPE alone, and the same shape the Slack app uses, for the same reason:
 * a predicate over the whole resource does not narrow an optional property
 * path through it, so the null and id checks stay inline at the call site
 * where the typechecker can see them.
 *
 * @param {string | undefined} type
 * @returns {boolean}
 */
export function isGoalRunResourceType(type) {
	return type !== undefined && GOAL_RUN_RESOURCE_TYPES.has(type);
}
