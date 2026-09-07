import type {
  EvalCase,
  EvalSuite,
  EvalSuiteConfigTest,
  EvalSuiteRun,
} from "@/components/evals/types";
import type { ServerWithName } from "@/state/app-types";
import { isOpaqueId, mintCaseId } from "@mcpjam/sdk/contract";
import {
  resolvePromptTurns,
  stripPromptTurnsFromAdvancedConfig,
  type PromptTurn,
  type TestStep,
} from "@/shared/steps";
import { stepsToPromptTurns } from "@/shared/steps";

/**
 * Resolve a case's prompt turns for export, preferring the unified `steps`
 * model when present (the backend now emits `steps`, not `promptTurns`).
 * Falls back to the legacy resolver for pre-migration rows.
 */
function resolveExportPromptTurns(source: {
  steps?: unknown;
  promptTurns?: unknown;
  advancedConfig?: unknown;
  query?: string;
  expectedToolCalls?: unknown;
  expectedOutput?: string;
}): PromptTurn[] {
  // Gate on length, not mere array-ness: an empty `steps: []` must fall through
  // to the query→turn-1 fallback (matches server resolveSteps / resolveEvalTestCase).
  if (Array.isArray(source.steps) && source.steps.length > 0) {
    return stepsToPromptTurns(source.steps as never);
  }
  return resolvePromptTurns(source);
}

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
  /** Canonical case definition; `promptTurns` kept for legacy export consumers. */
  steps?: TestStep[];
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
  testCase: EvalCase
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
    promptTurns: resolveExportPromptTurns(testCase),
    advancedConfig:
      stripPromptTurnsFromAdvancedConfig(testCase.advancedConfig) ?? undefined,
    modelHints:
      testCase.models?.map(
        (modelConfig) => `${modelConfig.provider}/${modelConfig.model}`
      ) ?? [],
  };
}

export function normalizeSuiteConfigTestForExport(
  test: EvalSuiteConfigTest,
  index: number
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
    promptTurns: resolveExportPromptTurns(test),
    advancedConfig:
      stripPromptTurnsFromAdvancedConfig(test.advancedConfig) ?? undefined,
    modelHints:
      test.provider && test.model
        ? [`${test.provider}/${test.model}`]
        : undefined,
  };
}

export function normalizeDraftEvalCaseForExport(
  draft: EvalExportDraftInput
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
  suiteRuns: EvalSuiteRun[]
): EvalExportCaseInput[] {
  if (persistedCases.length > 0) {
    return persistedCases.map((testCase) =>
      normalizeEvalCaseForExport(testCase)
    );
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
    normalizeSuiteConfigTestForExport(test, index)
  );
}

export function buildSdkInstallSnippet(): string {
  return SDK_EXPORT_INSTALL_SNIPPET;
}

export function buildSdkEnvSnippet(
  serverIds: string[],
  serverEntries: Record<string, ServerWithName | undefined>,
  projectId?: string | null
): SdkEnvSnippetResult {
  const serverConnections = buildServerConnections(serverIds, serverEntries);
  const httpConnections = serverConnections.filter(
    (
      connection
    ): connection is Extract<ExportServerConnection, { kind: "http" }> =>
      connection.kind === "http"
  );
  const stdioConnections = serverConnections.filter(
    (
      connection
    ): connection is Extract<ExportServerConnection, { kind: "stdio" }> =>
      connection.kind === "stdio"
  );

  const lines = [
    "export EVAL_MODEL=<provider/model-id>",
    "# Use the API key variable your provider expects; rename in the test file if needed.",
    "export LLM_API_KEY=<your-llm-api-key>",
    "# Optional: an MCPJam API key (sk_…, Settings → API keys) auto-saves results to your Evals dashboard.",
    "export MCPJAM_API_KEY=<your sk_… key>",
    // Pin uploads to the project this export came from; without it they
    // land in the org's Default project.
    ...(projectId ? [`export MCPJAM_PROJECT_ID=${projectId}`] : []),
  ];

  if (httpConnections.length > 0) {
    lines.push("", "# HTTP MCP servers");
    for (const connection of httpConnections) {
      lines.push(
        connection.placeholder
          ? `export ${connection.envVarName}=<replace-with-server-url>`
          : `export ${connection.envVarName}=${shellSingleQuote(
              connection.url
            )}`
      );
    }
  }

  if (stdioConnections.length > 0) {
    lines.push(
      "",
      "# STDIO MCP servers are configured inline in the generated test file"
    );
    for (const connection of stdioConnections) {
      lines.push(
        `# ${collapseToSingleLine(
          connection.serverId
        )}: ${collapseToSingleLine(
          formatCommandDisplay(connection.command, connection.args)
        )}`
      );
      if (connection.envKeys.length > 0) {
        lines.push(
          `# ${collapseToSingleLine(
            connection.serverId
          )} also expects local env vars: ${collapseToSingleLine(
            connection.envKeys.join(", ")
          )}`
        );
      }
    }
  }

  return {
    snippet: lines.join("\n"),
    usedPlaceholderFallback: serverConnections.some(
      (connection) => connection.placeholder
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
  const needsPartialArgMatching = anyTestCaseUsesPartialArgMatching(cases);
  // Must match the multi-turn branch in `buildCaseTestBlock` EXACTLY: that
  // branch is the `else` of `promptTurns.length === 1`, so it also renders
  // `ExportedTurn[]` for a case with NO turns. Guarding on `> 1` emitted the
  // reference without its declaration (TS2304) for the empty case.
  const needsTurnType = cases.some((c) => c.promptTurns.length !== 1);
  const sdkImports = ["  MCPClientManager,", "  HostRunner,", "  EvalTest,"];
  if (needsPartialArgMatching) {
    sdkImports.push("  matchToolCallWithPartialArgs,");
  }

  const lines: string[] = [
    'import { describe, it, expect, beforeAll, afterAll } from "vitest";',
    "import {",
    ...sdkImports,
    '} from "@mcpjam/sdk";',
    "",
    "type ServerConnection =",
    '  | { id: string; kind: "http"; url: string }',
    '  | { id: string; kind: "stdio"; command: string; args: string[] };',
    "",
    // Annotated rather than `as const`: a const-asserted literal gives
    // `expectedToolCalls.length` the LITERAL type of each turn's length, so the
    // `expected.length === 0` guard below fails to compile (TS2367) on any case
    // whose turns all declare the same non-zero number of calls.
    ...(needsTurnType
      ? [
          "type ExportedTurn = {",
          "  prompt: string;",
          "  expectedToolCalls: { toolName: string; arguments: Record<string, unknown> }[];",
          "};",
          "",
        ]
      : []),
    "const SERVER_CONFIGS: ServerConnection[] = [",
    indentBlock(renderServerConnectionEntries(serverConnections), 2),
    "];",
    "",
    "const SERVER_IDS = SERVER_CONFIGS.map((server) => server.id);",
    "const LLM_API_KEY = process.env.LLM_API_KEY!;",
    "const MODEL = process.env.EVAL_MODEL!;",
    `const SUITE_NAME = ${JSON.stringify(suite.name || "MCPJam export")};`,
  ];

  if (suite.description?.trim()) {
    lines.push(
      "",
      ...toCommentLines(suite.description.trim()).map((line) => `// ${line}`)
    );
  }

  if (usedPlaceholderFallback) {
    lines.push(
      "// Some server connection details were unavailable locally.",
      "// Replace any placeholder values before running this file."
    );
  }

  lines.push(
    "",
    `describe(SUITE_NAME, () => {`,
    "  let manager: MCPClientManager;",
    "  let agent: HostRunner;",
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
    "    agent = new HostRunner({",
    "      tools,",
    "      model: MODEL,",
    "      apiKey: LLM_API_KEY,",
    "      maxSteps: 8,",
    "      mcpClientManager: manager,",
    "    });",
    "  }, 120_000);",
    "",
    "  afterAll(async () => {",
    "    await manager.disconnectAllServers();",
    "  }, 120_000);"
  );

  if (cases.length === 0) {
    lines.push(
      "",
      "  // No saved cases were available for this suite yet.",
      "  // Add or run cases in MCPJam, then export again."
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
  scope: "suite" | "test-case"
): string {
  const safeName = sanitizeFilename(suiteName || "mcpjam-export");
  return scope === "suite" ? `${safeName}.eval.test.ts` : `${safeName}.test.ts`;
}

export function buildAgentPromptExportFileName(suiteName: string): string {
  const safeName = sanitizeFilename(suiteName || "mcpjam-export");
  return `${safeName}.agent-prompt.md`;
}

export function buildServerConnections(
  serverIds: string[],
  serverEntries: Record<string, ServerWithName | undefined>
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

/**
 * The `id` literal written into the exported file.
 *
 * Prefers the dashboard case's own id so the exported code-first test joins the
 * hosted case's history. Neither branch derives an id from display text: an id
 * derived from a title forks history on the first rename, which is exactly what
 * a declared id exists to prevent.
 *
 * The fallback MINTS a fresh id rather than numbering by position. A positional
 * id (`c_exported_3`) is order-dependent identity: export, insert a case above
 * it, export again, and two different cases have swapped committed ids — which
 * joins each to the other's history the moment either is uploaded. A minted id
 * is at worst brand new, never someone else's. Validity is checked with the
 * contract's own `isOpaqueId`, not a local regex, so this cannot drift from the
 * rule the SDK enforces at construction.
 */
function exportedCaseId(testCase: EvalExportCaseInput): string {
  const declared = testCase.id?.trim();
  if (declared && isOpaqueId(declared)) {
    return declared;
  }
  return mintCaseId();
}

function buildCaseTestBlock(
  testCase: EvalExportCaseInput,
  index: number
): string {
  const caseTitle = testCase.title || `Exported case ${index + 1}`;
  const promptTurns = testCase.promptTurns;
  const firstTurn = promptTurns[0];

  const allExpectedToolCalls = promptTurns.flatMap(
    (turn) => turn.expectedToolCalls ?? []
  );

  const lines: string[] = [
    "  it(",
    `    ${JSON.stringify(caseTitle)},`,
    "    async () => {",
  ];

  pushCaseComments(lines, testCase);

  // Build EvalTest config.
  //
  // `id` is the case's declared identity and is required by the SDK. Emit the
  // dashboard case's own id when we have it — the exported file then joins back
  // to the same history — and mint a fresh one only for a case that never had
  // one. Either way it is minted ONCE, into a file the user commits, so a later
  // rename of `name` cannot fork the case.
  lines.push(
    "      const evalTest = new EvalTest({",
    `        id: ${JSON.stringify(exportedCaseId(testCase))},`,
    `        name: ${JSON.stringify(caseTitle)},`
  );

  if (allExpectedToolCalls.length > 0) {
    lines.push(
      `        expectedToolCalls: ${indentBlock(
        JSON.stringify(allExpectedToolCalls, null, 2),
        8
      ).trimStart()},`
    );
  }

  // Build test callback
  if (promptTurns.length === 1 && firstTurn) {
    lines.push(
      "        test: async (agent) => {",
      `          const result = await agent.run(${JSON.stringify(
        firstTurn.prompt
      )});`
    );
    lines.push(
      `          return ${buildSingleTurnReturnExpression(
        firstTurn,
        testCase.isNegativeTest
      )};`
    );
    lines.push("        },");
  } else {
    lines.push(
      "        test: async (agent) => {",
      "          const turns: ExportedTurn[] =",
      `${indentBlock(
        JSON.stringify(
          promptTurns.map((turn) => ({
            prompt: turn.prompt,
            expectedToolCalls: turn.expectedToolCalls ?? [],
          })),
          null,
          2
        ),
        12
      )};`,
      "          const results: Awaited<ReturnType<typeof agent.run>>[] = [];",
      "",
      "          for (const turn of turns) {",
      "            const result = await agent.run(turn.prompt, {",
      "              context: results.length > 0 ? results : undefined,",
      "            });",
      "            results.push(result);",
      "          }",
      ""
    );

    if (testCase.isNegativeTest) {
      lines.push(
        "          return results.every((result) => result.toolsCalled().length === 0);"
      );
    } else {
      lines.push(
        "          return results.every((result, i) => {",
        "            const expected = turns[i].expectedToolCalls;",
        "            if (expected.length === 0) return true;",
        "            return expected.every((tc) =>",
        "              Object.keys(tc.arguments ?? {}).length > 0",
        "                ? matchToolCallWithPartialArgs(tc.toolName, tc.arguments, result.getToolCalls())",
        "                : result.hasToolCall(tc.toolName),",
        "            );",
        "          });"
      );
    }

    lines.push("        },");
  }

  lines.push(
    "      });",
    "",
    `      await evalTest.run(agent, {`,
    `        iterations: ${testCase.runs || 1},`,
    `        // Auto-saves to MCPJam when MCPJAM_API_KEY (sk_…) is set; local-only otherwise.`,
    `        mcpjam: { suiteName: SUITE_NAME },`,
    `      });`,
    "      expect(evalTest.accuracy()).toBe(1);"
  );

  lines.push("    },", "    90_000,", "  );");
  return lines.filter(Boolean).join("\n");
}

function buildSingleTurnReturnExpression(
  turn: {
    expectedToolCalls: Array<{
      toolName: string;
      arguments: Record<string, any>;
    }>;
  },
  isNegativeTest: boolean
): string {
  if (isNegativeTest) {
    return "result.toolsCalled().length === 0";
  }

  const expectedToolCalls = turn.expectedToolCalls ?? [];
  if (expectedToolCalls.length === 0) {
    return "true";
  }

  const checks: string[] = [];
  for (const tc of expectedToolCalls) {
    const hasArgs = Object.keys(tc.arguments ?? {}).length > 0;
    if (hasArgs) {
      checks.push(
        `matchToolCallWithPartialArgs(${JSON.stringify(
          tc.toolName
        )}, ${JSON.stringify(tc.arguments)}, result.getToolCalls())`
      );
    } else {
      checks.push(`result.hasToolCall(${JSON.stringify(tc.toolName)})`);
    }
  }

  if (checks.length === 1) {
    return checks[0]!;
  }

  return `(\n            ${checks.join(" &&\n            ")}\n          )`;
}

/**
 * Whether any case's generated body REFERENCES `matchToolCallWithPartialArgs`.
 *
 * This has to mirror the emission sites exactly, not approximate them — an
 * import guard that is narrower than the code it guards emits a call with no
 * import (TS2304), which is how a multi-turn case whose turns declare no
 * arguments used to produce a file that could not compile.
 *
 * A negative case never references the matcher (it asserts no tool ran), and
 * the MULTI-TURN branch always does — its loop keeps the partial-args ternary
 * whether or not this particular case supplies arguments. Only the single-turn
 * branch actually varies with the arguments present.
 */
function anyTestCaseUsesPartialArgMatching(
  cases: EvalExportCaseInput[]
): boolean {
  return cases.some((testCase) => {
    if (testCase.isNegativeTest) {
      return false;
    }
    if (testCase.promptTurns.length !== 1) {
      return true;
    }
    return testCase.promptTurns.some((turn) =>
      (turn.expectedToolCalls ?? []).some(
        (tc) => Object.keys(tc.arguments ?? {}).length > 0
      )
    );
  });
}

/**
 * Per-turn state the exported file cannot evaluate.
 *
 * A turn carries more than `prompt` + `expectedToolCalls`: `checks` are
 * deterministic predicates (including every ADVISORY `toolCalledWith`, which
 * `stepsToPromptTurns` deliberately leaves as a predicate), `widgetChecks` are
 * DOM-level, and `pinnedToolCall` marks a MODEL-FREE turn. The generated
 * `test()` reads none of them, so they are named here rather than dropped
 * silently — an author who sees the case pass locally needs to know what that
 * pass did and did not cover.
 */
function describeUntranslatedTurnState(testCase: EvalExportCaseInput): string[] {
  const notes: string[] = [];

  testCase.promptTurns.forEach((turn, index) => {
    const label = `turn ${index + 1}`;
    for (const check of turn.checks ?? []) {
      const role = (check as { role?: string }).role === "advisory"
        ? "advisory"
        : "gating";
      notes.push(
        `  ${label}: ${role} check "${String(
          (check as { type?: string }).type ?? "unknown"
        )}" is NOT evaluated by this file.`
      );
    }
    for (const widgetCheck of turn.widgetChecks ?? []) {
      notes.push(
        `  ${label}: widget checks on "${widgetCheck.toolName}" need a hosted run; NOT evaluated here.`
      );
    }
    if (turn.pinnedToolCall) {
      // Deliberately not "asserts nothing": a NEGATIVE case's callback is a
      // single `results.every(... toolsCalled().length === 0)`, which covers
      // this turn like any other. What is true in both branches is that the
      // pinned call never runs and the turn prompts with an empty string.
      notes.push(
        `  ${label}: pinned (model-free) call "${turn.pinnedToolCall.toolName}" is NOT replayed; the turn sends an empty prompt and only the case's own assertions apply.`
      );
    }
  });

  if (notes.length === 0) {
    return [];
  }
  return [
    "Not carried over from MCPJam — run this case in the hosted suite to cover it:",
    ...notes,
  ];
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
    commentLines.push(
      `Model hints from MCPJam: ${testCase.modelHints.join(", ")}`
    );
  }

  commentLines.push(...describeUntranslatedTurnState(testCase));

  const advancedConfig = testCase.advancedConfig ?? undefined;
  if (advancedConfig && Object.keys(advancedConfig).length > 0) {
    commentLines.push(
      "Advanced config captured in MCPJam (apply manually if you need stricter runtime parity):"
    );
    commentLines.push(...JSON.stringify(advancedConfig, null, 2).split("\n"));
  }

  if (commentLines.length === 0) {
    return;
  }

  // Split here rather than at each call site: this is the ONE place a case's
  // free-text fields reach the file, so a value that carries a line terminator
  // cannot escape its comment no matter which field it came from.
  for (const entry of commentLines) {
    for (const line of toCommentLines(entry)) {
      lines.push(`      // ${line}`);
    }
  }
  lines.push("");
}

function renderServerConnectionEntries(
  connections: ExportServerConnection[]
): string {
  const lines: string[] = [];

  for (const connection of connections) {
    if (connection.kind === "http") {
      if (connection.placeholder) {
        lines.push(
          `// Replace the placeholder URL for ${JSON.stringify(
            connection.serverId
          )} with the real server URL if needed.`
        );
      }
      lines.push(
        "{",
        `  id: ${JSON.stringify(connection.serverId)},`,
        '  kind: "http",',
        `  url: process.env.${connection.envVarName} ?? ${JSON.stringify(
          connection.url
        )},`,
        "},"
      );
      continue;
    }

    lines.push(
      `// ${JSON.stringify(
        connection.serverId
      )} runs over stdio: ${collapseToSingleLine(
        formatCommandDisplay(connection.command, connection.args)
      )}`
    );
    if (connection.envKeys.length > 0) {
      lines.push(
        `// Add any required local env vars before running: ${collapseToSingleLine(
          connection.envKeys.join(", ")
        )}`
      );
    }
    lines.push(
      "{",
      `  id: ${JSON.stringify(connection.serverId)},`,
      '  kind: "stdio",',
      `  command: ${JSON.stringify(connection.command)},`,
      `  args: ${JSON.stringify(connection.args)},`,
      "},"
    );
  }

  return lines.join("\n");
}

/**
 * Every line terminator JavaScript recognizes.
 *
 * U+2028 / U+2029 belong here beside CR and LF: both end a line in JS source,
 * and `JSON.stringify` does NOT escape them, so a value that survived
 * serialization can still terminate a comment.
 */
const LINE_TERMINATORS = /[\r\n\u2028\u2029]/;

/**
 * Split a value into physical lines so the caller can prefix each one as its
 * own comment.
 *
 * A `//` (or shell `#`) comment ends at the first line terminator, so an
 * interpolated value carrying one does not merely garble the comment — the
 * remainder becomes executable code in a file the author is about to run. Case
 * titles, scenarios, and tool names all originate outside this codebase (an
 * MCP server names its own tools), so none of them may be pasted into a
 * comment whole. Splitting rather than escaping keeps genuinely multi-line
 * prose readable, which is the common case.
 */
function toCommentLines(value: unknown): string[] {
  return String(value).split(LINE_TERMINATORS);
}

/**
 * Quote a value for a POSIX shell so the shell treats it as literal text.
 *
 * Collapsing line terminators is not enough on its own: this snippet is meant
 * to be COPIED INTO A TERMINAL, so an unquoted `$(...)`, backtick, `;` or `&`
 * in a saved server URL runs as a command the moment it is pasted. Single
 * quotes suppress every expansion, and the `'\''` dance is the standard way
 * to carry a literal single quote through them.
 */
function shellSingleQuote(value: string): string {
  return `'${collapseToSingleLine(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Flatten a value onto ONE line, for places that cannot span lines — a shell
 * `export VAR=value`, where a newline would not comment out but would run as
 * the next command.
 */
function collapseToSingleLine(value: string): string {
  return value.split(LINE_TERMINATORS).join(" ");
}

function normalizeOptionalString(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeFilename(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "mcpjam-export"
  );
}

function sanitizeEnvSegment(value: string): string {
  return (
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "SERVER"
  );
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
