import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { createSuiteFileRunner } from "../src/suite-file-run/run-suite-file.js";
import {
  servePolicyTargetFixture,
  type PolicyTargetFixture,
} from "./support/policy-target-fixture.js";

/**
 * `mcpjam test --host <template>` runs the template's Progressive tools
 * setting: the Goose template is On, so the model starts on the search/load
 * meta-tools and reaches the real server only through a loaded tool.
 */

let fixture: PolicyTargetFixture;
beforeEach(async () => {
  fixture = await servePolicyTargetFixture();
});
afterEach(async () => {
  await fixture.close();
});

const SUITE = `schemaVersion: "2"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_discovery_test
  name: discovery test
target:
  servers:
    - name: notes
defaults:
  judge:
    enabled: false
  model: anthropic/claude-haiku-4.5
  iterations: 1
  passThreshold: 1
  validity: {}
cases:
  - id: c_read
    title: reads the note
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 7
      - id: a1
        kind: assert
        assertion:
          type: toolCalledWith
          toolName: read_note
          args:
            args: {}
`;

const STEPS = [
  { call: "search_mcp_tools", input: { query: "read note" } },
  { call: "load_mcp_tools", input: { names: ["read_note"] } },
  { call: "read_note", input: { id: "7" } },
] as const;

function discoveryModel() {
  const offered: string[][] = [];
  const usage = {
    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 2, text: 2, reasoning: 0 },
  };
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      offered.push((options.tools ?? []).map((tool) => tool.name).sort());
      const step = STEPS[offered.length - 1];
      if (!step) {
        return {
          content: [{ type: "text" as const, text: "Note 7 says hello." }],
          finishReason: { unified: "stop" as const, raw: "end_turn" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `call-${offered.length}`,
            toolName: step.call,
            input: JSON.stringify(step.input),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
        usage,
        warnings: [],
      };
    },
  });
  return { model, offered };
}

describe("runSuiteFile with a template's Progressive tools setting", () => {
  it("Goose (On): the model searches, loads read_note and calls the server once", async () => {
    const { model, offered } = discoveryModel();
    const { run } = createSuiteFileRunner({ createLanguageModel: () => model });
    const result = await run(SUITE, {
      servers: {
        notes: { config: { url: fixture.url }, source: "test-binding" },
      },
      inference: {
        mode: "byok",
        providerKeys: { anthropic: "sk-ant-test-key" },
      },
      hostTemplateId: "goose",
    });

    expect(result.verdict).toBe("passed");
    expect(fixture.calls.read_note).toBe(1);
    expect(offered[0]).toEqual(["load_mcp_tools", "search_mcp_tools"]);
    expect(offered[2]).toContain("read_note");
  });
});
