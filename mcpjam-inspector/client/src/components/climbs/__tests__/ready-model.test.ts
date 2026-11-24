import { describe, expect, it } from "vitest";
import { defaultOptionId, entriesForOption, optionDisabledReason } from "../ready-model";
import { failedRun, makeClimb, makeOption } from "./fixtures";

const entry = (where: object) => ({ rank: 1, where, current: "", readBy: [], readByAnyClient: true, failedIterations: 0, failedRuns: [], tried: [] }) as never;

describe("defaultOptionId", () => {
  it("starts a pass rate climb on the first option with failed runs behind it", () => {
    const climb = makeClimb({
      climbFor: [
        makeOption({ id: "pass_rate", label: "Pass rate" }),
        makeOption({ id: "tool_inputs", failedRuns: [failedRun(1)] }),
      ],
    });
    expect(defaultOptionId(climb)).toBe("tool_inputs");
  });
  it("starts a climb for tokens on tokens", () => {
    const climb = makeClimb({
      measure: "tokens",
      climbFor: [makeOption({ id: "pass_rate" }), makeOption({ id: "tokens", measure: "tokens" })],
    });
    expect(defaultOptionId(climb)).toBe("tokens");
  });
  it("is undefined before the options exist", () => {
    expect(defaultOptionId(makeClimb())).toBeUndefined();
  });
});

describe("optionDisabledReason", () => {
  it("gives the backend's reason for an option that cannot be chosen", () => {
    expect(optionDisabledReason(makeClimb(), makeOption({ available: false, reason: "Every case passes." }))).toBe("Every case passes.");
  });
  it("fixes the measure once round 1 has settled", () => {
    const climb = makeClimb({ measureLocked: true });
    expect(optionDisabledReason(climb, makeOption({ measure: "tokens" }))).toMatch(/fixed once round 1/);
    expect(optionDisabledReason(climb, makeOption())).toBeUndefined();
  });
});

describe("entriesForOption", () => {
  const entries = [
    entry({ kind: "tool", field: "description", tool: "a", mockPath: "p" }),
    entry({ kind: "param", field: "params.description", tool: "a", param: "x", mockPath: "p" }),
    entry({ kind: "server", field: "instructions", mockPath: "instructions" }),
    entry({ kind: "tool", field: "hidden", tool: "b", mockPath: "p" }),
  ];
  it("keeps the changes that belong to the option", () => {
    expect(entriesForOption(entries, "tool_descriptions")).toHaveLength(1);
    expect(entriesForOption(entries, "tool_inputs")).toHaveLength(1);
    expect(entriesForOption(entries, "instructions")).toHaveLength(1);
    expect(entriesForOption(entries, "fewer_tools")).toHaveLength(1);
  });
  it("keeps them all for an option about no one field", () => {
    expect(entriesForOption(entries, "tokens")).toHaveLength(4);
    expect(entriesForOption(entries, undefined)).toHaveLength(4);
  });
});
