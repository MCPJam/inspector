/**
 * One tool call per step while a model can only discover tools.
 *
 * With progressive discovery a loaded tool is callable only from the next
 * step (search, then load, then call). A model that sends `load_mcp_tools`
 * and the tool it loads in one reply makes a call that cannot run yet, so a
 * step that offers only the meta-tools asks the provider for one tool call.
 */

import { META_TOOL_NAMES, type ProgressiveToolPlan } from "./discovery.js";

/** Whether a step offers the model nothing but the discovery meta-tools. */
export function offersOnlyMetaTools(
  plan: ProgressiveToolPlan | undefined,
  toolNames: readonly string[],
): boolean {
  return (
    plan?.enabled === true &&
    toolNames.length > 0 &&
    toolNames.every((name) => META_TOOL_NAMES.includes(name))
  );
}

/**
 * Provider options that limit a model reply to one tool call, keyed by the
 * provider id MCPJam uses (`anthropic`, `openai`, ...), or `undefined` when
 * the installed AI SDK provider has no such control (google, deepseek,
 * ollama, custom). Bedrock reads the `anthropic` key for Claude models, and
 * Azure falls back to the `openai` key.
 */
export function singleToolCallProviderOptions(
  providerKey: string | undefined,
): Record<string, Record<string, boolean>> | undefined {
  switch (providerKey) {
    case "anthropic":
    case "bedrock":
      return { anthropic: { disableParallelToolUse: true } };
    case "openai":
    case "azure":
      return { openai: { parallelToolCalls: false } };
    case "mistral":
      return { mistral: { parallelToolCalls: false } };
    case "xai":
      return { xai: { parallelToolCalls: false } };
    case "openrouter":
      // Spread as-is into the OpenRouter request body, so the wire name.
      return { openrouter: { parallel_tool_calls: false } };
    default:
      return undefined;
  }
}
