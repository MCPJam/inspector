import { describe, expect, it } from "vitest";
import {
  compileRecordedAppCase,
  type RecordedAppAction,
} from "../src/contract/recorded-app-case.js";

const click: RecordedAppAction = {
  toolCallId: "open-1",
  stepIndex: 0,
  action: "left_click",
  actor: "persona",
  ok: true,
  target: { role: "button", name: "Save" },
};

function compile(
  actions: RecordedAppAction[],
  args: Record<string, unknown> = {}
) {
  return compileRecordedAppCase({
    id: "case-form",
    title: "Save form",
    openingCall: {
      toolCallId: "open-1",
      serverName: "Forms",
      toolName: "open_form",
      arguments: args,
    },
    actions,
    assertions: [
      {
        kind: "textVisible",
        toolName: "open_form",
        text: "Saved",
      },
    ],
  });
}

describe("compileRecordedAppCase", () => {
  it("orders the actions and emits stable model-free steps", () => {
    const next = { ...click, stepIndex: 1 };
    const compiled = compile([next, click]);
    expect(compiled).toEqual(compile([click, next]));
    expect(compiled.steps.map(({ kind }) => kind)).toEqual([
      "toolCall",
      "interact",
      "interact",
      "assert",
    ]);
  });

  it("rejects a sequence above the browser budget before saving it", () => {
    expect(() => compile(Array.from({ length: 12 }, (_, stepIndex) => ({ ...click, stepIndex }))))
      .toThrow(/at most 12 clicks and assertions/);
  });

  it("refuses opening inputs redacted in the transcript", () => {
    expect(() =>
      compile([click], { account: { id: "[secret:ACCOUNT]" } })
    ).toThrow("Opening call arguments contain redacted or truncated values.");
  });

  it.each([
    { actor: "model" },
    { ok: false },
    { target: undefined },
    { stepIndex: 2 },
    { toolCallId: "other-app" },
    { followUps: ["Send a message"] },
  ] satisfies Array<Partial<RecordedAppAction>>)(
    "rejects a trace that needs an unsupported action (%j)",
    (override) => {
      expect(() => compile([{ ...click, ...override }])).toThrow(
        /Recorded action/
      );
    }
  );
});
