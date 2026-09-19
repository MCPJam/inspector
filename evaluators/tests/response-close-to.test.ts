import {
  assertion,
  runEvaluatorsProjected,
  evaluatePredicate,
  predicateSchema,
} from "../src/index";
import {
  normalizedResponseDistance,
  MAX_RESPONSE_CLOSE_TO_CHARS,
} from "../src/predicates/response-close-to";
const context = {
  version: 1 as const,
  scenario: { title: "case" },
  trace: { messages: [] },
};
it.each([
  ["kitten", "sitting", 3 / 7],
  ["HELLO", "hello", 0],
  ["😀", "😁", 1],
  ["😀a", "😀b", 0.5],
  ["", "a", 1],
  ["é", "e\u0301", 1],
])("distance %s vs %s is %s", (message, reference, distance) => {
  expect(normalizedResponseDistance(message, reference, {})).toBe(distance);
});
it("normalizes whitespace only when selected and preserves case when requested", () => {
  expect(
    normalizedResponseDistance(" HELLO\n world ", "hello world", {
      normalizeWhitespace: true,
    })
  ).toBe(0);
  expect(normalizedResponseDistance("A", "a", { caseSensitive: true })).toBe(1);
});
it.each([
  { reference: "", maxDistance: 0 },
  { reference: " ", maxDistance: 0, normalizeWhitespace: true },
  { reference: "a", maxDistance: NaN },
  { reference: "a", maxDistance: 1.1 },
  { reference: "a", maxDistance: -1 },
])("rejects invalid configuration %j", (rule) => {
  expect(
    predicateSchema.safeParse({ type: "responseCloseTo", ...rule }).success
  ).toBe(false);
});
it("keeps bounds unscored rather than declaring a bad response", async () => {
  const result = await runEvaluatorsProjected(
    [
      assertion({
        type: "responseCloseTo",
        reference: "a".repeat(2001),
        maxDistance: 1,
      }),
    ],
    {
      ...context,
      transcript: { toolCalls: [], finalAssistantMessage: "b".repeat(2000) },
    }
  );
  expect(result[0]).toMatchObject({ status: "error" });
  expect(result[0].score).toBeUndefined();
});
it("accepts the exact DP boundary and rejects the next cell", () => {
  expect(
    normalizedResponseDistance("a".repeat(2000), "a".repeat(2000), {})
  ).toBe(0);
  expect(() =>
    normalizedResponseDistance("a".repeat(2001), "b".repeat(2000), {})
  ).toThrow("computation limit");
});
it("checks linear bounds even against an empty operand", () => {
  expect(() =>
    normalizedResponseDistance(
      "",
      "a".repeat(MAX_RESPONSE_CLOSE_TO_CHARS + 1),
      {}
    )
  ).toThrow("linear input limit");
});
it("accepts turn scope and applies exact threshold equality", () => {
  const rule = {
    type: "responseCloseTo" as const,
    reference: "abc",
    maxDistance: 1 / 3,
    scope: { kind: "turn" as const, turn: 0 },
  };
  expect(predicateSchema.safeParse(rule).success).toBe(true);
  expect(
    evaluatePredicate({ toolCalls: [], finalAssistantMessage: "abd" }, rule)
  ).toMatchObject({ passed: true });
});
it("requires captured final text", async () => {
  const result = await runEvaluatorsProjected(
    [assertion({ type: "responseCloseTo", reference: "a", maxDistance: 1 })],
    { ...context, transcript: { toolCalls: [] } }
  );
  expect(result[0].status).toBe("error");
  expect(result[0].score).toBeUndefined();
});

it("handles long equal and nearly equal responses without a quadratic allocation", () => {
  expect(
    normalizedResponseDistance("A".repeat(100000), "a".repeat(100000), {})
  ).toBe(0);
  expect(
    normalizedResponseDistance(
      "a".repeat(50000) + "x" + "b".repeat(49999),
      "a".repeat(50000) + "y" + "b".repeat(49999),
      {}
    )
  ).toBe(1 / 100000);
  expect(normalizedResponseDistance("😀abc😀", "😀axc😀", {})).toBe(1 / 5);
});
