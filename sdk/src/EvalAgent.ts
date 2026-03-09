import type { PromptResult } from "./PromptResult.js";

/**
 * Options for the prompt() method
 */
export interface PromptOptions {
  /** Previous PromptResult(s) to include as conversation context for multi-turn conversations */
  context?: PromptResult | PromptResult[];
}

/**
 * Minimal agent interface for running eval tests.
 * TestAgent implements this; use TestAgent.mock() for deterministic tests
 * without the unsafe `as unknown as TestAgent` cast.
 */
export interface EvalAgent {
  prompt(message: string, options?: PromptOptions): Promise<PromptResult>;
  withOptions(options: Record<string, any>): EvalAgent;
  getPromptHistory(): PromptResult[];
  resetPromptHistory(): void;
}
