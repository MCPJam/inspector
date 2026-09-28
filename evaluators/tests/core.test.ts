import {
  assertion,
  normalizeMessages,
  runMessageEvaluators,
  runEvaluatorsProjected,
  toFeedbackEvaluator,
  toNamedEvaluator,
  evaluateToolCalls,
} from "../src/index";
import { assertion as sdkAssertion } from "../../sdk/src/evaluators/assertion";
const context = {
  version: 1 as const,
  scenario: { title: "case" },
  trace: { messages: [] },
};
it("shares definition identity with the SDK compatibility path", () => {
  const rule = { type: "responseContains" as const, needle: "hello" };
  expect(assertion(rule).definition).toEqual(sdkAssertion(rule).definition);
});
it("evaluates a pure assertion and matcher", async () => {
  const result = await runEvaluatorsProjected(
    [assertion({ type: "responseContains", needle: "hello" })],
    {
      ...context,
      transcript: { toolCalls: [], finalAssistantMessage: "hello" },
    },
  );
  expect(result[0]).toMatchObject({ status: "scored", score: 1, passed: true });
  expect(
    evaluateToolCalls(
      [{ toolName: "search", arguments: {} }],
      [{ toolName: "search", arguments: {} }],
    ).passed,
  ).toBe(true);
});
it.each([null, {}, [{ role: "assistant", content: [{ type: "unknown" }] }]])(
  "refuses unsupported messages: %j",
  (input) => {
    expect(normalizeMessages(input).status).toBe("unsupported");
  },
);
it.each(["toolNeverCalled", "onlyToolsCalled", "noToolErrors"] as const)(
  "does not pass %s from missing capture",
  async (type) => {
    const rule =
      type === "toolNeverCalled"
        ? { type, toolName: "delete" }
        : type === "onlyToolsCalled"
          ? { type, toolNames: ["search"] }
          : { type };
    const normalized = normalizeMessages([
      { role: "assistant", content: "hello" },
    ]);
    const result = await runMessageEvaluators(
      [assertion(rule)],
      normalized,
      context,
    );
    expect(result[0]).toMatchObject({ status: "error" });
    expect(result[0].score).toBeUndefined();
    expect(toFeedbackEvaluator(result[0]).score).toBeNull();
    expect(toNamedEvaluator(result[0]).score).toBeNull();
  },
);
it("permits explicitly captured empty tools", async () => {
  const evidence = normalizeMessages(
    [{ role: "assistant", content: "hello" }],
    { capture: { toolCalls: "complete", toolResults: "complete" } },
  );
  const results = await runMessageEvaluators(
    [assertion({ type: "noToolErrors" })],
    evidence,
    context,
  );
  expect(results[0]).toMatchObject({ status: "scored", score: 1 });
});
it("retains MCP error results and call identity", async () => {
  const evidence = normalizeMessages(
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "one",
            toolName: "search",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "one",
            toolName: "search",
            output: {
              isError: true,
              content: [{ type: "text", text: "failed" }],
            },
          },
        ],
      },
    ],
    { capture: { toolCalls: "complete", toolResults: "complete" } },
  );
  const results = await runMessageEvaluators(
    [assertion({ type: "noToolErrors" })],
    evidence,
    context,
  );
  expect(results[0]).toMatchObject({
    status: "scored",
    score: 0,
    passed: false,
  });
});
it("rejects malformed and oversized evidence without exposing raw content", () => {
  expect(
    normalizeMessages([{ role: "assistant", content: "secret" }], {
      maxBytes: 2,
    }),
  ).toEqual({
    status: "invalid",
    diagnostics: ["Messages exceed the normalization byte limit"],
  });
  expect(
    normalizeMessages([
      {
        role: "assistant",
        tool_calls: [
          {
            type: "function",
            function: { name: "tool", arguments: "invalid" },
          },
        ],
      },
    ]).status,
  ).toBe("invalid");
});
