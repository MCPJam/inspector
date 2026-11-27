// A declared output-schema check over pinned (`toolCall`) steps, against two
// real MCP servers through the real MCP client. Both servers declare a tool
// named `lookup` with different output schemas, so a result graded against
// the other server's declaration would fail or be ambiguous. The steps run
// through the real hosted step handlers and `executeSteps`, and the case-level
// check runs through the same verdict builder the runner calls after a run.
import { createServer, type Server as HttpServer } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";
import { MCPClientManager } from "@mcpjam/sdk";
import type { Predicate, ToolErrorRecord } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import { buildEvalIterationVerdict } from "../iteration-verdict";
import { buildHostedStepHandlers } from "../step-handlers";
import { createStepExecutionState, executeSteps } from "../step-executor";
import { collectToolDeclarations, toolCallFailure } from "../transcript-evidence";

vi.mock("../drive-hosted-eval-turn", () => ({
  driveHostedEvalTurn: vi.fn(async () => ({ kind: "completed" })),
  MAX_WIDGET_FOLLOWUP_TURNS: 3,
}));

type OutputSchema = {
  type: "object";
  properties: Record<string, { type: string }>;
  required: string[];
};
const ALPHA_LOOKUP: OutputSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};
const BETA_LOOKUP: OutputSchema = {
  type: "object",
  properties: { rank: { type: "number" } },
  required: ["rank"],
};

/** What each server's tools answer, per call; swapped per test. */
const answers: Record<string, () => Record<string, unknown>> = {};

type Fixture = { close(): Promise<void> };

async function startServer(
  manager: MCPClientManager,
  serverId: string,
  tools: Array<{ name: string; outputSchema: OutputSchema }>,
): Promise<Fixture> {
  const mcp = new Server(
    { name: `${serverId}-fixture`, version: "1" },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler("tools/list", async () => ({
    tools: tools.map((tool) => ({ ...tool, inputSchema: { type: "object" } })),
  }));
  mcp.setRequestHandler("tools/call", async ({ params: { name } }) => {
    const answer = answers[`${serverId}.${name}`];
    if (!answer) throw new Error(`No answer for ${serverId}.${name}`);
    return { content: [{ type: "text", text: "fixture result" }], ...answer() };
  });
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => `${serverId}-session`,
  });
  await mcp.connect(transport);
  const http: HttpServer = createServer((req, res) =>
    transport.handleRequest(req, res),
  );
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await manager.connectToServer(serverId, {
    url: `http://127.0.0.1:${address.port}/mcp`,
    mcpProtocolVersion: "2025-11-25",
  });
  return {
    async close() {
      await mcp.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

const manager = new MCPClientManager();
const servers = ["alpha", "beta"];
const fixtures: Fixture[] = [];

beforeAll(async () => {
  fixtures.push(
    await startServer(manager, "alpha", [
      { name: "lookup", outputSchema: ALPHA_LOOKUP },
      { name: "stats", outputSchema: ALPHA_LOOKUP },
    ]),
    await startServer(manager, "beta", [
      { name: "lookup", outputSchema: BETA_LOOKUP },
    ]),
  );
  // A run lists tools while preparing; that is also what records declarations.
  await manager.getToolsForAiSdk(servers);
});

afterAll(async () => {
  await manager.disconnectAllServers();
  await Promise.all(fixtures.map((fixture) => fixture.close()));
});

const declared: Predicate = {
  type: "toolResultMatchesSchema",
  schema: "declared",
};
const pinned = (serverName: string, toolName: string): TestStep => ({
  id: `${serverName}-${toolName}`,
  kind: "toolCall",
  serverName,
  toolName,
  arguments: {},
});

/** Runs the steps as the hosted runner does, then the after-run verdict. */
async function runCase(steps: TestStep[]) {
  const acc = {
    messageHistory: [] as ModelMessage[],
    traceMessageHistory: [] as ModelMessage[],
    capturedSpans: [],
    accumulatedUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolsCalledByPrompt: [] as Array<Array<{ toolName: string; arguments: Record<string, unknown> }>>,
  };
  const pinnedToolErrors: ToolErrorRecord[] = [];
  const browser = {
    setActivePromptIndex: vi.fn(),
    setActiveAuthoredStepId: vi.fn(),
    setActiveWidgetChecks: vi.fn(),
    setKeepWidgetsMountedForSteps: vi.fn(),
    dismissCarriedWidget: vi.fn(async () => {}),
    renderPinnedToolResult: vi.fn(async () => {}),
    drainFollowUps: vi.fn(() => [] as string[]),
    widgetRenderObservations: [] as never[],
  };
  const handlers = buildHostedStepHandlers({
    acc,
    browser,
    mcpClientManager: manager,
    selectedServers: servers,
    resolvePinnedServerKey: (call: { serverName: string }) => call.serverName,
    pinnedToolErrors,
    prepared: { allTools: {} },
    runStartedAt: 0,
    isAborted: () => false,
    extractToolCalls: () => [],
  } as never);
  const declarations = collectToolDeclarations(manager, servers);
  const state = createStepExecutionState(declarations);
  await executeSteps({ steps, state, browser: browser as never, handlers });
  const { predicateResults } = buildEvalIterationVerdict({
    ...declarations,
    pinnedCalls: state.pinnedCalls,
    promptTurns: acc.toolsCalledByPrompt.map((calls, index) => ({
      id: `turn-${index}`,
      prompt: "",
      expectedToolCalls: calls,
    })),
    toolsCalledByPrompt: acc.toolsCalledByPrompt,
    isNegativeTest: false,
    matchOptions: {},
    turnCheckResults: [],
    effectivePredicates: [declared],
    trace: { messages: acc.traceMessageHistory },
    usage: undefined,
    renderObservations: undefined,
    toolErrors: pinnedToolErrors,
    iterationError: undefined,
    failOnToolError: true,
    pinnedToolErrors,
    scriptedCheckFailures: [],
  });
  return { state, caseResult: predicateResults[0] };
}

describe("a declared output-schema check over pinned calls", () => {
  it("grades two successful pinned calls, each against its own server's schema", async () => {
    // Each result breaks the OTHER server's `lookup` schema.
    answers["alpha.lookup"] = () => ({ structuredContent: { id: "a1" } });
    answers["beta.lookup"] = () => ({ structuredContent: { rank: 1 } });
    const { state, caseResult } = await runCase([
      pinned("alpha", "lookup"),
      pinned("beta", "lookup"),
      { id: "step-check", kind: "assert", assertion: declared },
    ]);

    const stepCheck = state.assertionResults.find((r) => r.stepId === "step-check");
    expect(stepCheck?.predicateResult).toMatchObject({
      passed: true,
      reason: "2 result(s) match their tool's declared output schema",
    });
    expect(stepCheck?.predicateResult).not.toHaveProperty("status");
    expect(caseResult).toMatchObject({
      passed: true,
      reason: "2 result(s) match their tool's declared output schema",
    });
    expect(caseResult).not.toHaveProperty("status");
  });

  it("fails on the real client's rejections of a pinned call's structured content", async () => {
    answers["alpha.lookup"] = () => ({ structuredContent: { id: "a1" } });
    answers["beta.lookup"] = () => ({ structuredContent: { rank: "first" } });
    answers["alpha.stats"] = () => ({});
    const { caseResult } = await runCase([
      pinned("alpha", "lookup"),
      pinned("beta", "lookup"),
      pinned("alpha", "stats"),
    ]);

    expect(caseResult).toMatchObject({ passed: false });
    expect(caseResult?.status).toBeUndefined();
    expect(caseResult?.reason).toContain("2/3 result(s) did not match");
    expect(caseResult?.reason).toContain(
      '"lookup" returned structuredContent that the client rejected',
    );
    expect(caseResult?.reason).toContain(
      '"stats" declares an output schema but returned no structuredContent',
    );
  });

  it("skips a pinned call whose result declares a tool error", async () => {
    answers["alpha.lookup"] = () => ({ isError: true });
    const { caseResult } = await runCase([pinned("alpha", "lookup")]);

    expect(caseResult).toMatchObject({ passed: true, status: "not_applicable" });
  });
});

describe("the SDK's own output-schema rejection wording", () => {
  // Multi-round-trip tool calls bypass the client's check, so the SDK repeats
  // it and throws its own messages. Read them from the real validator.
  it.each([
    [{ structuredContent: { rank: "first" } }, "output_schema_mismatch"],
    [{}, "missing_structured_content"],
  ] as const)("classifies %j as %s", async (patch, expected) => {
    const rejection = await manager
      .assertMrtrToolOutputSchema("beta", "lookup", { content: [], ...patch })
      .then(() => undefined, (error: unknown) => error);
    if (!(rejection instanceof TypeError)) throw new Error("Expected a TypeError");
    for (const value of [String(rejection), rejection.message]) {
      expect(toolCallFailure({ type: "error-text", value }, "lookup")).toBe(expected);
    }
  });
});
