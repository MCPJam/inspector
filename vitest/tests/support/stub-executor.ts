/**
 * A `HostExecutor` that answers from a script instead of a model.
 *
 * The package's own tests must run in CI with no API key and no MCP server, so
 * the executor is the seam that gets replaced. Everything downstream of it —
 * `EvalTest.run`, the matcher, scoring, the gate — is the real implementation.
 */
import { PromptResult, type HostExecutor } from "@mcpjam/sdk";

export type StubTurn = {
  text?: string;
  toolCalls?: Array<{ toolName: string; arguments?: Record<string, unknown> }>;
  error?: string;
};

export function stubResult(prompt: string, turn: StubTurn): PromptResult {
  return new PromptResult({
    prompt,
    messages: [],
    text: turn.text ?? "ok",
    toolCalls: (turn.toolCalls ?? []).map((call) => ({
      toolName: call.toolName,
      arguments: call.arguments ?? {},
    })),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    latency: { e2eMs: 1, llmMs: 1, mcpMs: 0 },
    ...(turn.error !== undefined ? { error: turn.error } : {}),
  });
}

/**
 * Answers every prompt with the same canned turn.
 *
 * `withOptions` returns `this`: the wrapper never calls it, and returning a
 * fresh stub would quietly discard the prompt history tests assert on.
 */
export class StubExecutor implements HostExecutor {
  private history: PromptResult[] = [];

  constructor(private readonly turn: StubTurn = {}) {}

  async run(message: string): Promise<PromptResult> {
    const result = stubResult(message, this.turn);
    this.history.push(result);
    return result;
  }

  withOptions(): HostExecutor {
    return this;
  }

  getPromptHistory(): PromptResult[] {
    return this.history;
  }

  resetPromptHistory(): void {
    this.history = [];
  }
}
