const reportEvalResultsMocks = vi.hoisted(() => ({
  reportEvalResults: vi.fn(),
}));

vi.mock("../src/report-eval-results.js", () => ({
  reportEvalResults: reportEvalResultsMocks.reportEvalResults,
}));

import { EvalSuite } from "../src/EvalSuite";
import { EvalTest } from "../src/EvalTest";
import { PromptResult } from "../src/PromptResult";
import { HostRunner } from "../src/HostRunner";

function createPromptResult(): PromptResult {
  return PromptResult.from({
    prompt: "Test prompt",
    messages: [
      { role: "user", content: "Test prompt" },
      { role: "assistant", content: "Test response" },
    ],
    text: "Test response",
    toolCalls: [],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
  });
}

function createReplayAwareAgent() {
  const replayConfigs = [
    {
      serverId: "asana",
      url: "https://mcp.asana.com/sse",
      accessToken: "at_123",
    },
    {
      serverId: "github",
      url: "https://api.githubcopilot.com/mcp",
      accessToken: "gh_123",
    },
  ];

  return {
    run: vi.fn().mockResolvedValue(createPromptResult()),
    withOptions() {
      return this;
    },
    getPromptHistory: vi.fn().mockReturnValue([]),
    resetPromptHistory: vi.fn(),
    getServerReplayConfigs: vi.fn().mockReturnValue(replayConfigs),
  };
}

describe("server replay config auto-save wiring", () => {
  beforeEach(() => {
    reportEvalResultsMocks.reportEvalResults.mockReset();
    reportEvalResultsMocks.reportEvalResults.mockResolvedValue({
      suiteId: "suite",
      runId: "run",
      status: "completed",
      result: "passed",
      summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    });
  });

  it("exposes replay configs from HostRunner when a client manager is attached", () => {
    const replayConfigs = [
      {
        serverId: "asana",
        url: "https://mcp.asana.com/sse",
        accessToken: "at_123",
      },
    ];
    const agent = new HostRunner({
      tools: {},
      model: "openai/gpt-4o",
      apiKey: "test-api-key",
      mcpClientManager: {
        getServerReplayConfigs: vi.fn().mockReturnValue(replayConfigs),
      } as any,
    });

    expect(agent.getServerReplayConfigs()).toEqual(replayConfigs);
  });

  it("auto-infers replay configs for EvalTest uploads when the agent provides them", async () => {
    const agent = createReplayAwareAgent();
    const test = new EvalTest({
      id: "c_replay_1",
      name: "list-projects",
      test: async (evalAgent) => {
        await evalAgent.run("Show me my projects");
        return true;
      },
    });

    await test.run(agent as any, {
      iterations: 1,
      mcpjam: {
        apiKey: "sk_test_key",
        serverNames: ["asana"],
      },
    });

    expect(reportEvalResultsMocks.reportEvalResults).toHaveBeenCalledWith(
      expect.objectContaining({
        serverReplayConfigs: [
          {
            serverId: "asana",
            url: "https://mcp.asana.com/sse",
            accessToken: "at_123",
          },
        ],
      })
    );
  });

  it("auto-infers replay configs for EvalSuite uploads when the agent provides them", async () => {
    const agent = createReplayAwareAgent();
    const suite = new EvalSuite({ name: "Asana suite" });
    suite.add(
      new EvalTest({
        id: "c_replay_2",
        name: "asana-get-user",
        test: async (evalAgent) => {
          await evalAgent.run("Who am I in Asana?");
          return true;
        },
      })
    );

    await suite.run(agent as any, {
      iterations: 1,
      mcpjam: {
        apiKey: "sk_test_key",
        serverNames: ["asana"],
      },
    });

    expect(reportEvalResultsMocks.reportEvalResults).toHaveBeenCalledTimes(1);
    expect(reportEvalResultsMocks.reportEvalResults).toHaveBeenCalledWith(
      expect.objectContaining({
        serverReplayConfigs: [
          {
            serverId: "asana",
            url: "https://mcp.asana.com/sse",
            accessToken: "at_123",
          },
        ],
      })
    );
  });

  it("falls back to all inferred replay configs when serverNames is omitted", async () => {
    const agent = createReplayAwareAgent();
    const test = new EvalTest({
      id: "c_replay_3",
      name: "list-projects",
      test: async (evalAgent) => {
        await evalAgent.run("Show me my projects");
        return true;
      },
    });

    await test.run(agent as any, {
      iterations: 1,
      mcpjam: {
        apiKey: "sk_test_key",
      },
    });

    expect(reportEvalResultsMocks.reportEvalResults).toHaveBeenCalledWith(
      expect.objectContaining({
        serverReplayConfigs: [
          {
            serverId: "asana",
            url: "https://mcp.asana.com/sse",
            accessToken: "at_123",
          },
          {
            serverId: "github",
            url: "https://api.githubcopilot.com/mcp",
            accessToken: "gh_123",
          },
        ],
      })
    );
  });
});
