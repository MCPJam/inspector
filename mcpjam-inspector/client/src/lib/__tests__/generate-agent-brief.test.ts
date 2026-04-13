import { describe, expect, it } from "vitest";
import {
  generateAgentBrief,
  mapEvalCasesToAgentBriefExploreCases,
  type ExportPayload,
} from "../generate-agent-brief";

const minimalPayload: ExportPayload = {
  serverId: "test-server",
  exportedAt: "2026-01-01T00:00:00.000Z",
  tools: [],
  resources: [],
  prompts: [],
};

describe("generateAgentBrief", () => {
  it("includes explore cases after Negative Test and before skill tail", () => {
    const out = generateAgentBrief(minimalPayload, {
      serverUrl: "https://example.com/mcp",
      exploreTestCases: [
        {
          title: "Weather lookup",
          query: "What is the weather in Paris?",
          expectedToolCalls: [
            {
              toolName: "get_weather",
              arguments: { city: "Paris", units: "metric" },
            },
          ],
        },
        {
          title: "Negative sample",
          query: "What is the capital of France?",
          isNegativeTest: true,
          scenario: "Small talk only",
        },
      ],
    });

    expect(out).toContain("### Negative Test");
    expect(out).toContain("## Explore-generated test cases");
    expect(out).toContain("### Weather lookup");
    expect(out).toContain("What is the weather in Paris?");
    expect(out).toMatch(/`get_weather\(\{city: "Paris", units: "metric"\}\)`/);
    expect(out).toContain("### Negative sample");
    expect(out).toContain("**Negative test:**");
    expect(out.indexOf("## Explore-generated test cases")).toBeGreaterThan(
      out.indexOf("### Negative Test"),
    );
    expect(out.indexOf("---")).toBeGreaterThan(
      out.indexOf("## Explore-generated test cases"),
    );
    expect(out).toContain("name: playground-to-sdk-evals");
    expect(out).not.toContain("name: create-mcp-eval");
  });

  it("omits explore section when exploreTestCases is empty or omitted", () => {
    const without = generateAgentBrief(minimalPayload);
    expect(without).not.toContain("## Explore-generated test cases");
    expect(without).toContain("name: create-mcp-eval");
    expect(without).not.toContain("name: playground-to-sdk-evals");

    const empty = generateAgentBrief(minimalPayload, { exploreTestCases: [] });
    expect(empty).not.toContain("## Explore-generated test cases");
    expect(empty).toContain("name: create-mcp-eval");
    expect(empty).not.toContain("name: playground-to-sdk-evals");
  });

  it("mapEvalCasesToAgentBriefExploreCases maps Eval-shaped rows for the explore skill tail", () => {
    const mapped = mapEvalCasesToAgentBriefExploreCases([
      {
        title: "Flowchart",
        query: "Draw a flowchart",
        isNegativeTest: false,
        scenario: "User wants a diagram",
        expectedOutput: "A rendered chart",
        expectedToolCalls: [
          { toolName: "draw", arguments: { format: "mermaid" } },
        ],
      },
      {
        title: "Small talk",
        query: "Hello",
        isNegativeTest: true,
        scenario: "No tools",
        expectedToolCalls: [],
      },
    ]);

    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      title: "Flowchart",
      query: "Draw a flowchart",
      isNegativeTest: false,
      scenario: "User wants a diagram",
      expectedOutput: "A rendered chart",
      expectedToolCalls: [
        { toolName: "draw", arguments: { format: "mermaid" } },
      ],
    });
    expect(mapped[1].expectedToolCalls).toBeUndefined();

    const out = generateAgentBrief(minimalPayload, {
      serverUrl: "http://localhost/mcp",
      exploreTestCases: mapped,
    });
    expect(out).toContain("## Explore-generated test cases");
    expect(out).toContain("name: playground-to-sdk-evals");
  });

  it("includes multi-turn explore cases when prompt turns are present", () => {
    const mapped = mapEvalCasesToAgentBriefExploreCases([
      {
        title: "Multi-turn",
        query: "First turn",
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
            expectedOutput: "A sent confirmation",
          },
        ],
      },
    ]);

    const out = generateAgentBrief(minimalPayload, {
      exploreTestCases: mapped,
    });

    expect(mapped[0]?.promptTurns).toHaveLength(2);
    expect(out).toContain("#### Turn 1");
    expect(out).toContain("Find the customer");
    expect(out).toContain("#### Turn 2");
    expect(out).toContain("A sent confirmation");
    expect(out).toMatch(/`send_email\(\{template: "follow-up"\}\)`/);
  });
});
