import type {
  EvalCase,
  EvalSuite,
  EvalSuiteConfigTest,
  EvalSuiteRun,
} from "@/components/evals/types";
import type { ServerWithName } from "@/state/app-types";
import {
  resolvePromptTurns,
  stripPromptTurnsFromAdvancedConfig,
  type PromptTurn,
} from "@/shared/prompt-turns";

export const SDK_EXPORT_INSTALL_SNIPPET = "npm install @mcpjam/sdk";

export type EvalExportDraftInput = {
  testCaseId?: string | null;
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  expectedOutput?: string;
  promptTurns?: PromptTurn[];
  isNegativeTest?: boolean;
  advancedConfig?: Record<string, unknown>;
  scenario?: string;
};

export type EvalExportCaseInput = {
  id?: string;
  title: string;
  query: string;
  runs: number;
  isNegativeTest: boolean;
  scenario?: string;
  expectedOutput?: string;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  promptTurns: PromptTurn[];
  advancedConfig?: Record<string, unknown>;
  modelHints?: string[];
};

type ExportServerConnection =
  | {
      serverId: string;
      kind: "http";
      url: string;
      envVarName: string;
      placeholder: boolean;
    }
  | {
      serverId: string;
      kind: "stdio";
      command: string;
      args: string[];
      envKeys: string[];
      placeholder: boolean;
    };

export type SdkEnvSnippetResult = {
  snippet: string;
  usedPlaceholderFallback: boolean;
  missingServerIds: string[];
};

export type SdkTestFileInput = {
  suite: Pick<EvalSuite, "name" | "description">;
  cases: EvalExportCaseInput[];
  serverConnections: ExportServerConnection[];
  usedPlaceholderFallback?: boolean;
};

export function normalizeEvalCaseForExport(
  testCase: EvalCase,
): EvalExportCaseInput {
  return {
    id: testCase._id,
    title: testCase.title || "Untitled test case",
    query: testCase.query || "",
    runs: testCase.runs || 1,
    isNegativeTest: testCase.isNegativeTest === true,
    scenario: normalizeOptionalString(testCase.scenario),
    expectedOutput: normalizeOptionalString(testCase.expectedOutput),
    expectedToolCalls: testCase.expectedToolCalls || [],
    promptTurns: resolvePromptTurns(testCase),
    advancedConfig:
      stripPromptTurnsFromAdvancedConfig(testCase.advancedConfig) ?? undefined,
    modelHints:
      testCase.models?.map(
        (modelConfig) => `${modelConfig.provider}/${modelConfig.model}`,
      ) ?? [],
  };
}

export function normalizeSuiteConfigTestForExport(
  test: EvalSuiteConfigTest,
  index: number,
): EvalExportCaseInput {
  return {
    id: test.testCaseId ?? `config-test-${index + 1}`,
    title: test.title || `Config test ${index + 1}`,
    query: test.query || "",
    runs: test.runs || 1,
    isNegativeTest: test.isNegativeTest === true,
    scenario: normalizeOptionalString(test.scenario),
    expectedOutput: normalizeOptionalString(test.expectedOutput),
    expectedToolCalls: test.expectedToolCalls || [],
    promptTurns: resolvePromptTurns(test),
    advancedConfig:
      stripPromptTurnsFromAdvancedConfig(test.advancedConfig) ?? undefined,
    modelHints:
      test.provider && test.model
        ? [`${test.provider}/${test.model}`]
        : undefined,
  };
}

export function normalizeDraftEvalCaseForExport(
  draft: EvalExportDraftInput,
): EvalExportCaseInput {
  return {
    id: draft.testCaseId ?? undefined,
    title: draft.title || "Untitled test case",
    query: draft.query || "",
    runs: draft.runs || 1,
    isNegativeTest: draft.isNegativeTest === true,
    scenario: normalizeOptionalString(draft.scenario),
    expectedOutput: normalizeOptionalString(draft.expectedOutput),
    expectedToolCalls: draft.expectedToolCalls || [],
    promptTurns: resolvePromptTurns(draft),
    advancedConfig:
      stripPromptTurnsFromAdvancedConfig(draft.advancedConfig) ?? undefined,
  };
}

export function pickSuiteExportCases(
  persistedCases: EvalCase[],
  suiteRuns: EvalSuiteRun[],
): EvalExportCaseInput[] {
  if (persistedCases.length > 0) {
    return persistedCases.map((testCase) => normalizeEvalCaseForExport(testCase));
  }

  const latestRunWithTests = [...suiteRuns]
    .filter((run) => run.configSnapshot?.tests?.length > 0)
    .sort((left, right) => {
      const leftTime = left.completedAt ?? left.createdAt ?? 0;
      const rightTime = right.completedAt ?? right.createdAt ?? 0;
      return rightTime - leftTime;
    })[0];

  if (!latestRunWithTests) {
    return [];
  }

  return latestRunWithTests.configSnapshot.tests.map((test, index) =>
    normalizeSuiteConfigTestForExport(test, index),
  );
}

export function buildSdkInstallSnippet(): string {
  return SDK_EXPORT_INSTALL_SNIPPET;
}

export function buildSdkEnvSnippet(
  serverIds: string[],
  serverEntries: Record<string, ServerWithName | undefined>,
): SdkEnvSnippetResult {
  const serverConnections = buildServerConnections(serverIds, serverEntries);
  const httpConnections = serverConnections.filter(
    (connection): connection is Extract<ExportServerConnection, { kind: "http" }> =>
      connection.kind === "http",
  );
  const stdioConnections = serverConnections.filter(
    (
      connection,
    ): connection is Extract<ExportServerConnection, { kind: "stdio" }> =>
      connection.kind === "stdio",
  );

  const lines = [
    "export MCPJAM_API_KEY=<workspace-api-key>",
    "export EVAL_MODEL=<provider/model-id>",
    "# Use the API key variable your provider expects; rename in the test file if needed.",
    "export LLM_API_KEY=<your-llm-api-key>",
  ];

  if (httpConnections.length > 0) {
    lines.push("", "# HTTP MCP servers");
    for (const connection of httpConnections) {
      lines.push(
        connection.placeholder
          ? `export ${connection.envVarName}=<replace-with-server-url>`
          : `export ${connection.envVarName}=${connection.url}`,
      );
    }
  }

  if (stdioConnections.length > 0) {
    lines.push("", "# STDIO MCP servers are configured inline in the generated test file");
    for (const connection of stdioConnections) {
      lines.push(
        `# ${connection.serverId}: ${formatCommandDisplay(connection.command, connection.args)}`,
      );
      if (connection.envKeys.length > 0) {
        lines.push(
          `# ${connection.serverId} also expects local env vars: ${connection.envKeys.join(", ")}`,
        );
      }
    }
  }

  return {
    snippet: lines.join("\n"),
    usedPlaceholderFallback: serverConnections.some(
      (connection) => connection.placeholder,
    ),
    missingServerIds: serverConnections
      .filter((connection) => connection.placeholder)
      .map((connection) => connection.serverId),
  };
}

export function buildSdkTestFile({
  suite,
  cases,
  serverConnections,
  usedPlaceholderFallback = false,
}: SdkTestFileInput): string {
  const lines: string[] = [
    'import { describe, it, expect, beforeAll, afterAll } from "vitest";',
    "import {",
    "  MCPClientManager,",
    "  TestAgent,",
    "  createEvalRunReporter,",
    "  matchNoToolCalls,",
    "  matchToolCallWithPartialArgs,",
    '} from "@mcpjam/sdk";',
    "",
    'type ServerConnection =',
    '  | { id: string; kind: "http"; url: string }',
    '  | { id: string; kind: "stdio"; command: string; args: string[] };',
    "",
    "function evaluateExpectedToolCalls(",
    "  result: Awaited<ReturnType<TestAgent[\"prompt\"]>>,",
    "  expectedToolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }>,",
    "  isNegativeTest: boolean,",
    "): boolean {",
    "  if (isNegativeTest) {",
    "    return matchNoToolCalls(result.toolsCalled());",
    "  }",
    "",
    "  if (expectedToolCalls.length === 0) {",
    "    return true;",
    "  }",
    "",
    "  return expectedToolCalls.every((expectedCall) => {",
    "    if (Object.keys(expectedCall.arguments ?? {}).length > 0) {",
    "      return matchToolCallWithPartialArgs(",
    "        expectedCall.toolName,",
    "        expectedCall.arguments,",
    "        result.getToolCalls(),",
    "      );",
    "    }",
    "    return result.hasToolCall(expectedCall.toolName);",
    "  });",
    "}",
    "",
    "const SERVER_CONFIGS: ServerConnection[] = [",
    indentBlock(renderServerConnectionEntries(serverConnections), 2),
    "];",
    "",
    "const SERVER_IDS = SERVER_CONFIGS.map((server) => server.id);",
    "const LLM_API_KEY = process.env.LLM_API_KEY!;",
    "const MODEL = process.env.EVAL_MODEL!;",
    "const MCPJAM_API_KEY = process.env.MCPJAM_API_KEY;",
  ];

  if (suite.description?.trim()) {
    lines.push(
      "",
      `// ${suite.description.trim()}`,
    );
  }

  if (usedPlaceholderFallback) {
    lines.push(
      "// Some server connection details were unavailable locally.",
      "// Replace any placeholder values before running this file.",
    );
  }

  lines.push(
    "",
    `describe(${JSON.stringify(suite.name || "MCPJam export")}, () => {`,
    "  let manager: MCPClientManager;",
    "  let agent: TestAgent;",
    "  let reporter: ReturnType<typeof createEvalRunReporter> | undefined;",
    "",
    "  beforeAll(async () => {",
    "    manager = new MCPClientManager();",
    "    for (const server of SERVER_CONFIGS) {",
    '      if (server.kind === "http") {',
    "        await manager.connectToServer(server.id, { url: server.url });",
    "        continue;",
    "      }",
    "      await manager.connectToServer(server.id, {",
    "        command: server.command,",
    "        args: server.args,",
    "      });",
    "    }",
    "",
    "    const tools = await manager.getToolsForAiSdk(SERVER_IDS);",
    "    agent = new TestAgent({",
    "      tools,",
    "      model: MODEL,",
    "      apiKey: LLM_API_KEY,",
    "      maxSteps: 8,",
    "      mcpClientManager: manager,",
    "    });",
    "",
    "    if (MCPJAM_API_KEY) {",
    "      reporter = createEvalRunReporter({",
    `        suiteName: ${JSON.stringify(suite.name || "MCPJam export")},`,
    "        apiKey: MCPJAM_API_KEY,",
    "        strict: true,",
    "        mcpClientManager: manager,",
    "        serverNames: SERVER_IDS,",
    `        expectedIterations: ${cases.length},`,
    "      });",
    "    }",
    "  }, 120_000);",
    "",
    "  afterAll(async () => {",
    "    if (reporter?.getAddedCount()) {",
    "      try {",
    "        await reporter.finalize();",
    "      } catch (error) {",
    '        console.warn("MCPJam reporter finalize failed (non-fatal):", error);',
    "      }",
    "    }",
    "    await manager.disconnectAllServers();",
    "  }, 120_000);",
  );

  if (cases.length === 0) {
    lines.push(
      "",
      "  // No saved cases were available for this suite yet.",
      "  // Add or run cases in MCPJam, then export again.",
    );
  } else {
    for (const [index, testCase] of cases.entries()) {
      lines.push("", buildCaseTestBlock(testCase, index));
    }
  }

  lines.push("});");
  return lines.join("\n");
}

export function buildSuiteExportFileName(
  suiteName: string,
  scope: "suite" | "test-case",
): string {
  const safeName = sanitizeFilename(suiteName || "mcpjam-export");
  return scope === "suite"
    ? `${safeName}.eval.test.ts`
    : `${safeName}.test.ts`;
}

export function buildAgentPromptExportFileName(suiteName: string): string {
  const safeName = sanitizeFilename(suiteName || "mcpjam-export");
  return `${safeName}.agent-prompt.md`;
}

export function buildServerConnections(
  serverIds: string[],
  serverEntries: Record<string, ServerWithName | undefined>,
): ExportServerConnection[] {
  return serverIds.map((serverId) => {
    const serverEntry = serverEntries[serverId];
    const envVarName = `MCP_SERVER_URL_${sanitizeEnvSegment(serverId)}`;

    if (!serverEntry) {
      return {
        serverId,
        kind: "http",
        url: "<replace-with-server-url>",
        envVarName,
        placeholder: true,
      };
    }

    const config = serverEntry.config as Record<string, unknown>;
    if (typeof config.url === "string" || config.url instanceof URL) {
      return {
        serverId,
        kind: "http",
        url: config.url.toString(),
        envVarName,
        placeholder: false,
      };
    }

    if (typeof config.command === "string") {
      return {
        serverId,
        kind: "stdio",
        command: config.command,
        args: Array.isArray(config.args)
          ? config.args.filter((arg): arg is string => typeof arg === "string")
          : [],
        envKeys:
          config.env && typeof config.env === "object"
            ? Object.keys(config.env as Record<string, unknown>)
            : [],
        placeholder: false,
      };
    }

    return {
      serverId,
      kind: "http",
      url: "<replace-with-server-url>",
      envVarName,
      placeholder: true,
    };
  });
}

function buildCaseTestBlock(
  testCase: EvalExportCaseInput,
  index: number,
): string {
  const caseTitle = testCase.title || `Exported case ${index + 1}`;
  const promptTurns = testCase.promptTurns;
  const firstTurn = promptTurns[0];
  const advancedConfig = testCase.advancedConfig ?? undefined;
  const recordAdvancedConfig =
    promptTurns.length > 1
      ? {
          ...(advancedConfig ?? {}),
          promptTurns,
        }
      : advancedConfig;

  const lines: string[] = [
    "  it(",
    `    ${JSON.stringify(caseTitle)},`,
    "    async () => {",
    `      const isNegativeTest = ${testCase.isNegativeTest ? "true" : "false"};`,
    `      const promptTurns =`,
    `${indentBlock(JSON.stringify(promptTurns, null, 2), 8)} as const;`,
    `      const advancedConfig =`,
    `${indentBlock(serializeTsValue(recordAdvancedConfig), 8)};`,
  ];

  pushCaseComments(lines, testCase);

  if (promptTurns.length === 1 && firstTurn) {
    lines.push(
      "      const promptTurn = promptTurns[0]!;",
      "      const result = await agent.prompt(promptTurn.prompt);",
      "      const passed = evaluateExpectedToolCalls(",
      "        result,",
      "        promptTurn.expectedToolCalls,",
      "        isNegativeTest,",
      "      );",
      "      expect(passed).toBe(true);",
      "",
      "      if (reporter) {",
      "        await reporter.recordFromPrompt(result, {",
      `          caseTitle: ${JSON.stringify(caseTitle)},`,
      "          query: promptTurn.prompt,",
      "          expectedToolCalls: promptTurn.expectedToolCalls,",
      "          passed,",
    );
    if (testCase.id) {
      lines.push(`          externalCaseId: ${JSON.stringify(testCase.id)},`);
    }
    if (testCase.isNegativeTest) {
      lines.push("          isNegativeTest: true,");
    }
    lines.push("          advancedConfig,", "        });", "      }");
  } else {
    lines.push(
      '      const promptResults: Array<Awaited<ReturnType<TestAgent["prompt"]>>> = [];',
      "",
      "      for (const promptTurn of promptTurns) {",
      "        const result = await agent.prompt(promptTurn.prompt, {",
      "          context: promptResults.length > 0 ? promptResults : undefined,",
      "        });",
      "        promptResults.push(result);",
      "      }",
      "",
      "      const passed = promptResults.every((result, promptIndex) =>",
      "        evaluateExpectedToolCalls(",
      "          result,",
      "          promptTurns[promptIndex]?.expectedToolCalls ?? [],",
      "          isNegativeTest,",
      "        ),",
      "      );",
      "      expect(passed).toBe(true);",
      "",
      "      if (reporter) {",
      "        await reporter.recordFromPrompts(promptResults, {",
      `          caseTitle: ${JSON.stringify(caseTitle)},`,
      "          passed,",
    );
    if (testCase.id) {
      lines.push(`          externalCaseId: ${JSON.stringify(testCase.id)},`);
    }
    if (testCase.isNegativeTest) {
      lines.push("          isNegativeTest: true,");
    }
    lines.push("          advancedConfig,", "        });", "      }");
  }

  lines.push("    },", "    90_000,", "  );");
  return lines.filter(Boolean).join("\n");
}

function pushCaseComments(lines: string[], testCase: EvalExportCaseInput) {
  const commentLines: string[] = [];
  if (testCase.scenario) {
    commentLines.push(`Scenario: ${testCase.scenario}`);
  }
  if (testCase.expectedOutput) {
    commentLines.push(`Expected output: ${testCase.expectedOutput}`);
  }
  if (testCase.modelHints && testCase.modelHints.length > 0) {
    commentLines.push(`Model hints from MCPJam: ${testCase.modelHints.join(", ")}`);
  }

  const advancedConfig = testCase.advancedConfig ?? undefined;
  if (advancedConfig && Object.keys(advancedConfig).length > 0) {
    commentLines.push(
      "Advanced config captured in MCPJam (apply manually if you need stricter runtime parity):",
    );
    commentLines.push(...JSON.stringify(advancedConfig, null, 2).split("\n"));
  }

  if (commentLines.length === 0) {
    return;
  }

  for (const line of commentLines) {
    lines.push(`      // ${line}`);
  }
  lines.push("");
}

function renderServerConnectionEntries(
  connections: ExportServerConnection[],
): string {
  const lines: string[] = [];

  for (const connection of connections) {
    if (connection.kind === "http") {
      if (connection.placeholder) {
        lines.push(
          `// Replace the placeholder URL for ${JSON.stringify(connection.serverId)} with the real server URL if needed.`,
        );
      }
      lines.push(
        "{",
        `  id: ${JSON.stringify(connection.serverId)},`,
        '  kind: "http",',
        `  url: process.env.${connection.envVarName} ?? ${JSON.stringify(connection.url)},`,
        "},",
      );
      continue;
    }

    lines.push(
      `// ${JSON.stringify(connection.serverId)} runs over stdio: ${formatCommandDisplay(
        connection.command,
        connection.args,
      )}`,
    );
    if (connection.envKeys.length > 0) {
      lines.push(
        `// Add any required local env vars before running: ${connection.envKeys.join(", ")}`,
      );
    }
    lines.push(
      "{",
      `  id: ${JSON.stringify(connection.serverId)},`,
      '  kind: "stdio",',
      `  command: ${JSON.stringify(connection.command)},`,
      `  args: ${JSON.stringify(connection.args)},`,
      "},",
    );
  }

  return lines.join("\n");
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeFilename(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "mcpjam-export";
}

function sanitizeEnvSegment(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "SERVER";
}

function formatCommandDisplay(command: string, args: string[]): string {
  return [command, ...args].filter(Boolean).join(" ").trim();
}

function indentBlock(value: string, spaces: number): string {
  const padding = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${padding}${line}`)
    .join("\n");
}

function serializeTsValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value, null, 2);
}
