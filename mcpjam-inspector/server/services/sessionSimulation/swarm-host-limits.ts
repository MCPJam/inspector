/**
 * Output-token ceiling for every swarm HOST step: the persona conversation's
 * assistant turns and the target's setup turn.
 *
 * Without one the backend sizes the ceiling to the model
 * (`defaultStreamMaxOutputTokens`: 32,768 for a reasoning model), and it
 * reserves credits against that ceiling before each step runs. A Haiku host
 * step held about 18 credits that way while spending a fraction of it, so a
 * free organization's daily credits read as spent after a handful of
 * concurrent sessions. 16,384 is the eval runner's long-standing per-step cap
 * (`drive-hosted-eval-turn.ts`) and roughly halves the hold.
 *
 * Scenario simulations deliberately send none: they keep the backend default.
 */
export const SWARM_HOST_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Output-token ceiling for a target's SETUP turn. Setup emits tool calls
 * (write arguments), not prose, so it needs far less room than a host turn,
 * and a starter target's setup allowance is priced at exactly this ceiling
 * (backend `SWARM_STARTER_SETUP_MAX_OUTPUT_TOKENS`): sending more would price
 * the step above what its row can admit, before its first call.
 */
export const SWARM_SETUP_MAX_OUTPUT_TOKENS = 4_096;
