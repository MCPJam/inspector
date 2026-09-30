import { HOSTED_STEP_MAX_OUTPUT_TOKENS } from "../hosted-step-limits";

/**
 * Output-token ceiling for every swarm HOST step: the persona conversation's
 * assistant turns and the target's setup turn.
 *
 * Without one the backend sizes the ceiling to the model
 * (`defaultStreamMaxOutputTokens`: 32,768 for a reasoning model), and it
 * reserves credits against that ceiling before each step runs. A Haiku host
 * step held about 18 credits that way while spending a fraction of it, so a
 * free organization's daily credits read as spent after a handful of
 * concurrent sessions. The eval runner's per-step cap
 * ({@link HOSTED_STEP_MAX_OUTPUT_TOKENS}) roughly halves the hold.
 *
 * It lowers the hold only for a model whose backend default is larger. The
 * backend's default for a non-reasoning model is 8,192, which this ceiling
 * DOUBLES, and the Inspector cannot tell the two apart: the hosted catalog it
 * reads carries no reasoning flag. Making it an upper bound on the backend's
 * default, per model, is a backend change.
 *
 * Scenario simulations deliberately send none: they keep the backend default.
 * Harness hosts never get one either: see `drainAssistantTurn`.
 */
export const SWARM_HOST_MAX_OUTPUT_TOKENS = HOSTED_STEP_MAX_OUTPUT_TOKENS;
