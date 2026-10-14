import { describe, expect, it } from "vitest";
import { interactActionSchema } from "../src/contract/steps";

const target = { testId: "control" };
describe("recorded action contract", () => {
  it.each([
    { kind: "select", target, values: ["pro", ""] },
    { kind: "select", target, values: [] },
    { kind: "scrollTo", target, x: -20, y: 300 },
    { kind: "key", key: "Control+Enter", target },
    { kind: "key", key: "Tab" },
    { kind: "scroll", direction: "down", amount: 3 },
  ])("preserves recorded and legacy action data: $kind", (action) => {
    expect(interactActionSchema.parse(action)).toEqual(action);
  });

  it.each([
    { kind: "select", target, values: [3] },
    { kind: "select", target, values: ["x".repeat(5001)] },
    { kind: "scrollTo", target, x: Number.NaN, y: 0 },
    { kind: "scrollTo", target, x: 0, y: Number.POSITIVE_INFINITY },
    { kind: "key", key: "Tab", target: {} },
    { kind: "key", key: "Tab", target: { testId: "control", extra: true } },
  ])("rejects malformed action data: $kind", (action) => {
    expect(interactActionSchema.safeParse(action).success).toBe(false);
  });
});
