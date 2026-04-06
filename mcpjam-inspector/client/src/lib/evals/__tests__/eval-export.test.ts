import { describe, expect, it } from "vitest";
import type {
  EvalCase,
  EvalSuiteRun,
} from "@/components/evals/types";
import type { ServerWithName } from "@/state/app-types";
import {
  buildSdkEnvSnippet,
  buildSdkTestFile,
  buildServerConnections,
  normalizeDraftEvalCaseForExport,
  pickSuiteExportCases,
} from "../eval-export";

const connectedHttpServer = {
  name: "weather",
  config: { url: "https://weather.example.com/mcp" },
  connectionStatus: "connected",
  lastConnectionTime: new Date(),
  retryCount: 0,
} satisfies ServerWithName;

describe("eval-export", () => {
  it("normalizes draft input and preserves multi-turn prompt data", () => {
    const draft = normalizeDraftEvalCaseForExport({
      testCaseId: "case-1",
      title: "Two turn flow",
      query: "ignored when promptTurns exists",
      runs: 2,
      promptTurns: [
        {
          id: "turn-1",
          prompt: "Find the user",
          expectedToolCalls: [{ toolName: "search_user", arguments: {} }],
        },
        {
          id: "turn-2",
          prompt: "Send the follow-up",
          expectedToolCalls: [
            {
              toolName: "send_email",
              arguments: { template: "follow-up" },
            },
          ],
        },
      ],
      expectedToolCalls: [],
      advancedConfig: { system: "Be strict" },
    });

    expect(draft.promptTurns).toHaveLength(2);
    expect(draft.promptTurns[1]?.prompt).toBe("Send the follow-up");
    expect(draft.advancedConfig).toEqual({ system: "Be strict" });
  });

  it("falls back to the latest run config snapshot when no persisted cases exist", () => {
    const suiteRuns: EvalSuiteRun[] = [
      {
        _id: "run-older",
        suiteId: "suite-1",
        createdBy: "u",
        runNumber: 1,
        configRevision: "1",
        configSnapshot: {
          tests: [
            {
              title: "Older",
              query: "old prompt",
              provider: "openai",
              model: "gpt-4o-mini",
              runs: 1,
              expectedToolCalls: [],
            },
          ],
          environment: { servers: ["weather"] },
        },
        status: "completed",
        createdAt: 10,
        completedAt: 20,
      },
      {
        _id: "run-latest",
        suiteId: "suite-1",
        createdBy: "u",
        runNumber: 2,
        configRevision: "2",
        configSnapshot: {
          tests: [
            {
              title: "Latest",
              query: "latest prompt",
              provider: "anthropic",
              model: "claude-sonnet",
              runs: 1,
              expectedToolCalls: [{ toolName: "lookup", arguments: {} }],
            },
          ],
          environment: { servers: ["weather"] },
        },
        status: "completed",
        createdAt: 30,
        completedAt: 40,
      },
    ];

    const exportedCases = pickSuiteExportCases([], suiteRuns);

    expect(exportedCases).toHaveLength(1);
    expect(exportedCases[0]?.title).toBe("Latest");
    expect(exportedCases[0]?.modelHints).toEqual(["anthropic/claude-sonnet"]);
  });

  it("emits placeholder environment variables when local server details are missing", () => {
    const envSnippet = buildSdkEnvSnippet(["weather", "calendar"], {
      weather: connectedHttpServer,
      calendar: undefined,
    });

    expect(envSnippet.usedPlaceholderFallback).toBe(true);
    expect(envSnippet.missingServerIds).toEqual(["calendar"]);
    expect(envSnippet.snippet).toContain(
      "export MCP_SERVER_URL_CALENDAR=<replace-with-server-url>",
    );
    expect(envSnippet.snippet).toContain(
      "export MCP_SERVER_URL_WEATHER=https://weather.example.com/mcp",
    );
  });

  it("exports multi-turn code where an unasserted first turn passes without tool calls", () => {
    const sdkFile = buildSdkTestFile({
      suite: { name: "Neutral first turn", description: "" },
      cases: [
        {
          id: "mt-neutral-first",
          title: "Optional tools then required",
          query: "Step one",
          runs: 1,
          isNegativeTest: false,
          expectedToolCalls: [],
          promptTurns: [
            {
              id: "turn-1",
              prompt: "Just acknowledge",
              expectedToolCalls: [],
            },
            {
              id: "turn-2",
              prompt: "Now fetch",
              expectedToolCalls: [{ toolName: "fetch_item", arguments: { id: "42" } }],
            },
          ],
        },
      ],
      serverConnections: buildServerConnections(["weather"], {
        weather: connectedHttpServer,
      }),
    });

    expect(sdkFile).toContain("if (expectedToolCalls.length === 0) {");
    expect(sdkFile).toContain("return true;");
    expect(sdkFile).toContain(
      "promptTurns[promptIndex]?.expectedToolCalls ?? [],",
    );
    expect(sdkFile).toContain('"prompt": "Just acknowledge"');
    expect(sdkFile).toMatch(/"expectedToolCalls":\s*\[\s*\]/);
    expect(sdkFile).toContain('"toolName": "fetch_item"');
  });

  it("builds a mixed suite file with single-turn, multi-turn, and negative cases", () => {
    const sdkFile = buildSdkTestFile({
      suite: {
        name: "Workspace export",
        description: "Generated from MCPJam",
      },
      cases: [
        {
          id: "single-case",
          title: "Single turn",
          query: "Fetch the weather",
          runs: 1,
          isNegativeTest: false,
          expectedToolCalls: [
            {
              toolName: "get_weather",
              arguments: { city: "Paris" },
            },
          ],
          promptTurns: [
            {
              id: "turn-1",
              prompt: "Fetch the weather",
              expectedToolCalls: [
                {
                  toolName: "get_weather",
                  arguments: { city: "Paris" },
                },
              ],
            },
          ],
        },
        {
          id: "multi-case",
          title: "Two turn follow-up",
          query: "Step one",
          runs: 1,
          isNegativeTest: false,
          expectedToolCalls: [],
          promptTurns: [
            {
              id: "turn-1",
              prompt: "Find the customer",
              expectedToolCalls: [{ toolName: "search_customer", arguments: {} }],
            },
            {
              id: "turn-2",
              prompt: "Send the follow-up",
              expectedToolCalls: [
                {
                  toolName: "send_email",
                  arguments: { template: "follow-up" },
                },
              ],
            },
          ],
          advancedConfig: { system: "Be concise" },
        },
        {
          id: "negative-case",
          title: "Negative",
          query: "Say hello",
          runs: 1,
          isNegativeTest: true,
          expectedToolCalls: [],
          promptTurns: [
            {
              id: "turn-1",
              prompt: "Say hello",
              expectedToolCalls: [],
            },
          ],
          scenario: "Small talk only",
        },
      ],
      serverConnections: buildServerConnections(["weather"], {
        weather: connectedHttpServer,
      }),
    });

    expect(sdkFile).toContain("recordFromPrompt(result");
    expect(sdkFile).toContain("recordFromPrompts(promptResults");
    expect(sdkFile).toContain("matchNoToolCalls(result.toolsCalled())");
    expect(sdkFile).toContain("matchToolCallWithPartialArgs(");
    expect(sdkFile).toContain("Scenario: Small talk only");
    expect(sdkFile).toContain("Generated from MCPJam");
  });

  it("prefers persisted cases over run snapshots when both exist", () => {
    const persistedCase: EvalCase = {
      _id: "persisted-case",
      testSuiteId: "suite-1",
      createdBy: "u",
      title: "Persisted",
      query: "live data",
      models: [],
      runs: 1,
      expectedToolCalls: [],
    };

    const exportedCases = pickSuiteExportCases([persistedCase], []);

    expect(exportedCases).toHaveLength(1);
    expect(exportedCases[0]?.title).toBe("Persisted");
  });
});
