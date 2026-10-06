/**
 * Output-token ceiling for one assistant step on MCPJam's hosted `/stream`
 * rail, for callers that run unattended loops of steps: the eval runner and
 * the swarm runner's host steps (the persona conversation's assistant turns and
 * the target's setup turn).
 *
 * The backend reserves credits against a step's ceiling before it runs, and
 * without one it sizes the ceiling to the model (`defaultStreamMaxOutputTokens`:
 * 32,768 for a reasoning model, 8,192 otherwise). A Haiku swarm host step held
 * about 18 credits that way while spending a fraction of it, so a free
 * organization's daily credits read as spent after a handful of concurrent
 * sessions; this ceiling roughly halves the hold. One number shared by both
 * callers, so a change to one cannot silently leave the other behind.
 *
 * It lowers the hold only for a model whose backend default is larger. The
 * backend's default for a non-reasoning model is 8,192, which this ceiling
 * DOUBLES, and the Inspector cannot tell the two apart: the hosted catalog it
 * reads carries no reasoning flag. Making it an upper bound on the backend's
 * default, per model, is a backend change.
 *
 * Scenario simulations deliberately send none: they keep the backend default.
 * Harness hosts never get one either: see `resolveTurnRuntime`.
 */
export const HOSTED_STEP_MAX_OUTPUT_TOKENS = 16_384;
