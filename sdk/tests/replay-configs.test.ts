const mockReportEvalResultsSafely = jest.fn();

jest.mock("../src/report-eval-results.js", () => ({
  reportEvalResultsSafely: mockReportEvalResultsSafely,
}));

import { EvalSuite } from "../src/EvalSuite";
import { EvalTest } from "../src/EvalTest";
import { PromptResult } from "../src/PromptResult";
import { TestAgent } from "../src/TestAgent";

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
    prompt: jest.fn().mockResolvedValue(createPromptResult()),
    withOptions() {
      return this;
    },
    getPromptHistory: jest.fn().mockReturnValue([]),
    resetPromptHistory: jest.fn(),
    getServerReplayConfigs: jest.fn().mockReturnValue(replayConfigs),
  };
}

describe("server replay config auto-save wiring", () => {
  beforeEach(() => {
    mockReportEvalResultsSafely.mockReset();
    mockReportEvalResultsSafely.mockResolvedValue(null);
  });

  it("exposes replay configs from TestAgent when a client manager is attached", () => {
    const replayConfigs = [
      {
        serverId: "asana",
        url: "https://mcp.asana.com/sse",
        accessToken: "at_123",
      },
    ];
    const agent = new TestAgent({
      tools: {},
      model: "openai/gpt-4o",
      apiKey: "test-api-key",
      mcpClientManager: {
        getServerReplayConfigs: jest.fn().mockReturnValue(replayConfigs),
      } as any,
    });

    expect(agent.getServerReplayConfigs()).toEqual(replayConfigs);
  });

  it("auto-infers replay configs for EvalTest uploads when the agent provides them", async () => {
    const agent = createReplayAwareAgent();
    const test = new EvalTest({
      name: "list-workspaces",
      test: async (evalAgent) => {
        await evalAgent.prompt("Show me my workspaces");
        return true;
      },
    });

    await test.run(agent as any, {
      iterations: 1,
      mcpjam: {
        apiKey: "mcpjam_test_key",
        serverNames: ["asana"],
      },
    });

    expect(mockReportEvalResultsSafely).toHaveBeenCalledWith(
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
        name: "asana-get-user",
        test: async (evalAgent) => {
          await evalAgent.prompt("Who am I in Asana?");
          return true;
        },
      })
    );

    await suite.run(agent as any, {
      iterations: 1,
      mcpjam: {
        apiKey: "mcpjam_test_key",
        serverNames: ["asana"],
      },
    });

    expect(mockReportEvalResultsSafely).toHaveBeenCalledTimes(1);
    expect(mockReportEvalResultsSafely).toHaveBeenCalledWith(
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
      name: "list-workspaces",
      test: async (evalAgent) => {
        await evalAgent.prompt("Show me my workspaces");
        return true;
      },
    });

    await test.run(agent as any, {
      iterations: 1,
      mcpjam: {
        apiKey: "mcpjam_test_key",
      },
    });

    expect(mockReportEvalResultsSafely).toHaveBeenCalledWith(
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
