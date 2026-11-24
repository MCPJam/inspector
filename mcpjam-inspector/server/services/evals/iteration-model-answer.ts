import type { ModelDefinition } from "../../../shared/types.js";
import { hostedModelCaller } from "../mock/model-call.js";
import type { ModelRequestAnswerer } from "./input-answers.js";

/** Said to the model when the server gave no system prompt of its own. */
const DEFAULT_SYSTEM =
  "An MCP server is asking you, the client's model, for text. Reply with only the text it asked for.";

/**
 * Answers a server's request for the model with the model the iteration runs
 * on, asked as the person who runs the eval on the hosted rail, so MCPJam's
 * hosted models are metered like any hosted step. One step, no tools.
 */
export function iterationModelAnswerer(args: {
  /** The run's bearer, with or without its `Bearer ` prefix. */
  bearer: string;
  projectId: string;
  definition: ModelDefinition;
  modelId: string;
}): ModelRequestAnswerer {
  const ask = hostedModelCaller({
    bearerToken: args.bearer.replace(/^Bearer\s+/i, ""),
    projectId: args.projectId,
    model: { definition: args.definition, id: args.modelId },
  });
  return ({ system, prompt, signal }) =>
    ask({ system: system ?? DEFAULT_SYSTEM, prompt, signal });
}
