import { describe, expect, it } from "vitest";
import {
  computeWidgetRecordMode,
  isRecorderStale,
  shouldSaveRecorderStep,
  shouldSaveLiveRecorderStep,
  type RecorderStepEvent,
  type RecordingTarget,
} from "../recorder-types";

const target: RecordingTarget = { promptIndex: 1, toolName: "create_view" };

describe("computeWidgetRecordMode", () => {
  it("records every widget on a record-capable surface (shim loads on first render)", () => {
    const r = computeWidgetRecordMode({
      recordCapable: true,
      recordingTarget: null,
      toolName: "search_products",
      toolCallId: "call_1",
      widgetPromptIndex: 0,
    });
    expect(r.recordMode).toBe(true);
    expect(r.promptIndex).toBe(0);
  });

  it("records the armed target even when not record-capable", () => {
    const r = computeWidgetRecordMode({
      recordCapable: false,
      recordingTarget: target,
      toolName: "create_view",
      toolCallId: "call_2",
      widgetPromptIndex: undefined,
    });
    expect(r.recordMode).toBe(true);
    // No span-resolved index → falls back to the armed target's promptIndex.
    expect(r.promptIndex).toBe(1);
  });

  it("does not record when neither capable nor armed-matching", () => {
    const r = computeWidgetRecordMode({
      recordCapable: false,
      recordingTarget: target,
      toolName: "other_tool",
      toolCallId: "call_3",
      widgetPromptIndex: 2,
    });
    expect(r.recordMode).toBe(false);
  });

  it("never records a widget without a toolCallId", () => {
    const r = computeWidgetRecordMode({
      recordCapable: true,
      recordingTarget: target,
      toolName: "create_view",
      toolCallId: undefined,
      widgetPromptIndex: 0,
    });
    expect(r.recordMode).toBe(false);
  });

  it("prefers the widget's own resolved promptIndex over the target's", () => {
    const r = computeWidgetRecordMode({
      recordCapable: true,
      recordingTarget: target,
      toolName: "create_view",
      toolCallId: "call_4",
      widgetPromptIndex: 3,
    });
    expect(r.promptIndex).toBe(3);
  });

  it("does not arm the same tool in a different turn (turn-scoped match)", () => {
    const r = computeWidgetRecordMode({
      recordCapable: false,
      recordingTarget: target, // { promptIndex: 1, toolName: "create_view" }
      toolName: "create_view",
      toolCallId: "call_5",
      widgetPromptIndex: 0, // same tool, wrong turn
    });
    expect(r.recordMode).toBe(false);
  });

  it("arms the same tool when its resolved turn matches the target", () => {
    const r = computeWidgetRecordMode({
      recordCapable: false,
      recordingTarget: target,
      toolName: "create_view",
      toolCallId: "call_6",
      widgetPromptIndex: 1, // matches target.promptIndex
    });
    expect(r.recordMode).toBe(true);
  });
});

describe("shouldSaveRecorderStep", () => {
  const event: RecorderStepEvent = {
    promptIndex: 1,
    toolName: "create_view",
    toolCallId: "call_1",
    step: { kind: "click" },
  };

  it("saves a step from the armed target", () => {
    expect(shouldSaveRecorderStep(target, event)).toBe(true);
  });

  it("drops a step from the wrong target (wrong target does not record)", () => {
    expect(
      shouldSaveRecorderStep(target, { ...event, toolName: "search_products" }),
    ).toBe(false);
  });

  it("drops a step from the same tool in a different turn", () => {
    expect(
      shouldSaveRecorderStep(target, { ...event, promptIndex: 0 }),
    ).toBe(false);
  });

  it("drops a step when nothing is armed", () => {
    expect(shouldSaveRecorderStep(null, event)).toBe(false);
  });
});

describe("shouldSaveLiveRecorderStep", () => {
  it("saves any step with a resolved turn (no arm required)", () => {
    expect(shouldSaveLiveRecorderStep({ promptIndex: 0 })).toBe(true);
    expect(shouldSaveLiveRecorderStep({ promptIndex: 3 })).toBe(true);
  });

  it("drops a step whose owning turn could not be resolved", () => {
    expect(shouldSaveLiveRecorderStep({ promptIndex: -1 })).toBe(false);
    expect(
      shouldSaveLiveRecorderStep({ promptIndex: NaN as unknown as number }),
    ).toBe(false);
    expect(
      shouldSaveLiveRecorderStep({ promptIndex: 1.5 as unknown as number }),
    ).toBe(false);
  });
});

describe("isRecorderStale", () => {
  it("is not stale before any preview run captured a fingerprint", () => {
    expect(
      isRecorderStale({
        recordingTarget: target,
        previewRunFingerprint: null,
        currentDraftFingerprint: "fp-1",
      }),
    ).toBe(false);
  });

  it("is not stale while the draft matches the run", () => {
    expect(
      isRecorderStale({
        recordingTarget: target,
        previewRunFingerprint: "fp-1",
        currentDraftFingerprint: "fp-1",
      }),
    ).toBe(false);
  });

  it("becomes stale (recording disabled) once the draft diverges", () => {
    expect(
      isRecorderStale({
        recordingTarget: target,
        previewRunFingerprint: "fp-1",
        currentDraftFingerprint: "fp-2",
      }),
    ).toBe(true);
  });

  it("is not stale when nothing is armed", () => {
    expect(
      isRecorderStale({
        recordingTarget: null,
        previewRunFingerprint: "fp-1",
        currentDraftFingerprint: "fp-2",
      }),
    ).toBe(false);
  });
});
