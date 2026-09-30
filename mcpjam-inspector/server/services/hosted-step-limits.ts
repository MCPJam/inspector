/**
 * Output-token ceiling for one assistant step on MCPJam's hosted `/stream`
 * rail, for callers that run unattended loops of steps: the eval runner and
 * the swarm runner's host steps.
 *
 * The backend reserves credits against a step's ceiling before it runs, and
 * without one it sizes the ceiling to the model (`defaultStreamMaxOutputTokens`:
 * 32,768 for a reasoning model, 8,192 otherwise). One number shared by both
 * callers, so a change to one cannot silently leave the other behind.
 */
export const HOSTED_STEP_MAX_OUTPUT_TOKENS = 16_384;
