/**
 * Ask MCPJam's pinned model and per-turn step ceiling.
 *
 * ## Why the agent does not ride the user's chosen model any more
 *
 * Agent turns are paid by MCPJam, not by the customer. The backend only
 * honours that claim for ONE model id (`convex/stream/agentBilling.ts`), for
 * the obvious reason: `/stream` is callable directly with a user bearer and
 * any catalog model, so "MCPJam pays when the body says it is an agent step"
 * would be free frontier chat for anyone who can set a JSON field.
 *
 * So the web route ignores `body.model` entirely and sends this. Before, the
 * agent rode the user's last-used Playground model, which could be a frontier
 * or BYOK model — fine when the customer paid, not something MCPJam can hand
 * out.
 *
 * GPT-5.6 Luna, the model the backend's analysis pipelines already run on.
 * Every step of a turn re-sends the whole conversation, so the agent's bill is
 * almost all input tokens. Luna's input price is a fifth of Haiku 4.5's, and
 * OpenAI caches a repeated prompt prefix on its own, so the part of a step
 * that repeats the one before it costs a tenth of that again. It is still not
 * a frontier model, which keeps it a poor thing to farm through throwaway
 * signups. The backend pins its reasoning effort; this side sends none.
 *
 * MIRRORED from the backend's `convex/lib/agentModel.ts`, pinned by that
 * repo's `convex/lib/mirrors.json` (`mcpjam-agent-model`). Drift is not
 * cosmetic: we send the model, the backend decides whether the turn is free,
 * and a mismatch refuses every agent turn with `agent_billing_rejected`.
 */
import type { ModelDefinition } from "./types.js";

export const MCPJAM_AGENT_MODEL = "openai/gpt-5.6-luna";

/**
 * Steps one agent turn may take. The backend enforces the same ceiling on
 * every attested step, so a loop that exceeds it here does not get a bigger
 * budget — it gets `agent_billing_rejected` mid-answer.
 */
export const AGENT_MAX_STEPS = 16;

/**
 * The routes that serve platform-paid Ask MCPJam work, and the ordinary ones
 * they shadow.
 *
 * A claimed turn MUST be posted to the PLATFORM path: the ordinary path refuses
 * a claim outright rather than serving it, because serving it is what silently
 * bills the customer for a turn the product calls free.
 *
 * The route is also the compatibility signal. A backend that predates these
 * paths answers 404, before any provider work, which is the only way to know
 * that no customer was charged. Confirming it on the RESPONSE cannot be: by the
 * time a header exists the backend has already admitted and billed the step.
 *
 * Mirrored with the backend's `convex/lib/agentModel.ts`, so a path typo on
 * either side fails `check:mirrors` instead of refusing every agent turn in
 * production.
 */
export const STREAM_PATH = "/stream";
export const PLATFORM_STREAM_PATH = "/stream/platform";
export const EXA_SEARCH_PATH = "/tools/exa/search";
export const PLATFORM_EXA_SEARCH_PATH = "/tools/exa/search/platform";

/** The pinned model as the engines want it. Hosted by definition: a BYOK rail
 *  would not be MCPJam-paid, and the backend would refuse the claim. */
export const MCPJAM_AGENT_MODEL_DEFINITION: ModelDefinition = {
  id: MCPJAM_AGENT_MODEL,
  name: "GPT-5.6 Luna",
  provider: "openai",
  hosted: true,
};

/** The body field that ASKS the backend to bill MCPJam. Only honoured
 *  alongside `x-inspector-service-token` and this model. */
export const MCPJAM_AGENT_BILLING_FEATURE = "mcpjam_agent";
