import type { HostConfigModelContextPolicyV1 } from "../types.js";

/**
 * ChatGPT's budgets for plugin Apps' `ui/update-model-context`. ChatGPT web
 * refuses an update past about 2.55 MB, per request; the block and turn
 * budgets are MCPJam guardrails. Mirrors the backend template.
 */
export const CHATGPT_MODEL_CONTEXT_POLICY: Required<HostConfigModelContextPolicyV1> =
  {
    maxBlocks: 256,
    turnMaxBytes: 8 * 1024 * 1024,
    updateMaxBytes: 2_548_000,
  };
