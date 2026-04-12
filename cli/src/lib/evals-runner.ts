import {
  MCPClientManager,
  TestAgent,
  EvalTest,
  EvalSuite,
  matchToolCalls,
  matchToolCallsSubset,
} from "@mcpjam/sdk";
import type { EvalSuiteResult } from "@mcpjam/sdk";
import type { EvalsConfig } from "./evals-config";

export interface RunOverrides {
  iterations?: number;
  concurrency?: number;
}

export async function runEvals(
  config: EvalsConfig,
  overrides: RunOverrides,
): Promise<EvalSuiteResult> {
  const manager = new MCPClientManager(config.servers);

  try {
    const tools = await manager.getTools();

    const agent = new TestAgent({
      tools,
      model: config.agent.model,
      apiKey: config.agent.apiKey,
      systemPrompt: config.agent.systemPrompt,
      temperature: config.agent.temperature,
      maxSteps: config.agent.maxSteps,
      mcpClientManager: manager,
    });

    const suite = new EvalSuite({
      name: config.mcpjam?.suiteName ?? "CLI Eval Suite",
      mcpjam: config.mcpjam,
    });

    for (const testCase of config.tests) {
      const matchMode = testCase.matchMode ?? "subset";
      const expected = testCase.expectedToolCalls;

      const evalTest = new EvalTest({
        name: testCase.name,
        test: async (evalAgent) => {
          const result = await evalAgent.prompt(testCase.prompt);

          // Surface prompt-level errors (model failures, connection issues)
          if (result.hasError()) {
            throw new Error(`Prompt error: ${result.getError()}`);
          }

          const called = result.toolsCalled();
          const matched = matchMode === "exact"
            ? matchToolCalls(expected, called)
            : matchToolCallsSubset(expected, called);

          if (!matched) {
            const actualStr = called.length > 0 ? called.join(", ") : "(none)";
            const expectedStr = expected.join(", ");
            throw new Error(
              `Tool call mismatch (${matchMode}): expected [${expectedStr}], got [${actualStr}]`,
            );
          }

          return true;
        },
        expectedToolCalls: expected.map((toolName) => ({ toolName })),
      });

      suite.add(evalTest);
    }

    const iterations =
      overrides.iterations ?? config.options?.iterations ?? 5;
    const concurrency =
      overrides.concurrency ?? config.options?.concurrency ?? 3;
    const timeoutMs = config.options?.timeoutMs ?? 30_000;
    const retries = config.options?.retries ?? 0;

    const result = await suite.run(agent, {
      iterations,
      concurrency,
      timeoutMs,
      retries,
    });

    return result;
  } finally {
    await manager.disconnectAllServers();
  }
}
