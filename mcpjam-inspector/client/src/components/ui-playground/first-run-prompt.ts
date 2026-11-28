import type { Tool } from "@modelcontextprotocol/client";

/**
 * The first chat after a connect should run the server's tools, the way Claude
 * or ChatGPT would, instead of asking the model to describe them.
 */
export const PLAYGROUND_FIRST_RUN_PROMPT =
  "Call each of your tools once and summarize what they returned.";

/** More tools than this would spend a lot of credits on the first message. */
export const FIRST_RUN_TOOL_CALL_LIMIT = 10;

const CAPPED_PROMPT = `Call up to ${FIRST_RUN_TOOL_CALL_LIMIT} of your tools once and summarize what they returned.`;
const NO_TOOLS_PROMPT = "List the resources and prompts this server exposes.";

function isDestructive(tool: Tool): boolean {
  return tool.annotations?.destructiveHint === true;
}

/**
 * Pick the first-run Playground prompt from the server's tool list.
 *
 * Destructive tools never count. The model does not see tool annotations, so
 * when some tools are destructive the prompt names the safe ones to call
 * rather than saying "your tools".
 */
export function chooseFirstRunPrompt(tools: readonly Tool[]): string {
  const safeTools = tools.filter((tool) => !isDestructive(tool));
  if (safeTools.length === 0) return NO_TOOLS_PROMPT;

  if (safeTools.length === tools.length) {
    return safeTools.length > FIRST_RUN_TOOL_CALL_LIMIT
      ? CAPPED_PROMPT
      : PLAYGROUND_FIRST_RUN_PROMPT;
  }

  const names = safeTools
    .slice(0, FIRST_RUN_TOOL_CALL_LIMIT)
    .map((tool) => tool.name)
    .join(", ");
  return `Call each of these tools once and summarize what they returned: ${names}.`;
}
