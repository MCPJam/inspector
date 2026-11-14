import { describe, expect, it } from "vitest";
import { describeAnswersGap } from "../../src/tasks-conformance/task-operations.js";

const asked = {
  confirm: {
    method: "elicitation/create",
    params: {
      message: "Which city?",
      requestedSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
};

describe("answers that cannot satisfy what the task asked for", () => {
  it("names a request left unanswered", () => {
    expect(describeAnswersGap(asked, {})).toBe('no answer for "confirm"');
  });

  it("names an answer to a request the task never made", () => {
    expect(
      describeAnswersGap(asked, {
        confirm: { action: "accept", content: { city: "Lima" } },
        other: { action: "accept", content: {} },
      })
    ).toBe('answers for requests the task did not make: "other"');
  });

  it("names accepted content the requested schema rejects", () => {
    expect(
      describeAnswersGap(asked, {
        confirm: { action: "accept", content: {} },
      })
    ).toMatch(/^the answer to "confirm" doesn't match what it asked for/);
  });

  it("reads only own keys, so an inherited name never counts as an answer", () => {
    const hostile = JSON.parse(
      '{"__proto__": {"method": "roots/list"}, "toString": {"method": "roots/list"}}'
    );
    expect(describeAnswersGap(hostile, {})).toBe(
      'no answer for "__proto__", "toString"'
    );
  });

  it("finds nothing wrong with answers that fit, or a decline", () => {
    expect(
      describeAnswersGap(asked, {
        confirm: { action: "accept", content: { city: "Lima" } },
      })
    ).toBeUndefined();
    expect(
      describeAnswersGap(asked, { confirm: { action: "decline" } })
    ).toBeUndefined();
    expect(describeAnswersGap(undefined, {})).toBeUndefined();
  });
});
