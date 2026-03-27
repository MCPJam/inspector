import { describe, expect, it } from "vitest";
import {
  generateAgentBrief,
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
    expect(out).toContain("name: explore-to-sdk-evals");
    expect(out).not.toContain("name: create-mcp-eval");
  });

  it("omits explore section when exploreTestCases is empty or omitted", () => {
    const without = generateAgentBrief(minimalPayload);
    expect(without).not.toContain("## Explore-generated test cases");
    expect(without).toContain("name: create-mcp-eval");
    expect(without).not.toContain("name: explore-to-sdk-evals");

    const empty = generateAgentBrief(minimalPayload, { exploreTestCases: [] });
    expect(empty).not.toContain("## Explore-generated test cases");
    expect(empty).toContain("name: create-mcp-eval");
    expect(empty).not.toContain("name: explore-to-sdk-evals");
  });
});
