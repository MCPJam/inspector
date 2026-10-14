import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useEvalRecorder } from "../use-eval-recorder";
import type { TestStep } from "@/shared/steps";

function useFixture({
  enabled = true,
  active = true,
  caseId = "case",
  onStop = () => {},
} = {}) {
  const [form, setForm] = useState<{ steps: TestStep[] } | null>({
    steps: [{ id: "prompt", kind: "prompt", prompt: "Q" }],
  });
  const capture = useEvalRecorder({
    enabled,
    active,
    caseId,
    mode: "record",
    setForm,
    onStop,
  });
  return { ...capture, form };
}
const event = (captureId: string, text: string) => ({
  captureId,
  promptIndex: 0,
  toolName: "view",
  toolCallId: "call",
  step: { kind: "type", target: { testId: "query" }, text },
});

describe("useEvalRecorder", () => {
  it("keeps saving until every widget acknowledges the stop", async () => {
    const onStop = vi.fn();
    const { result } = renderHook(() => useFixture({ onStop }));
    let finish!: (result: { ok: boolean }) => void;
    const flush = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    let stopped!: Promise<void>;
    act(() => {
      result.current.recorder!.onRecorderFlushReady!({
        toolCallId: "call",
        flush,
      });
      stopped = result.current.stopRecording();
    });
    expect(onStop).not.toHaveBeenCalled();
    await act(async () => {
      result.current.recorder!.onRecorderStep!(event("final", "pasted text"));
      finish({ ok: true });
      await stopped;
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(result.current.form!.steps[1]).toMatchObject({
      action: { text: "pasted text" },
    });
  });

  it("preserves batched captures and updates gestures in place", () => {
    const { result } = renderHook(() => useFixture());
    act(() => {
      result.current.recorder!.onRecorderStep!(event("type", "a"));
      result.current.recorder!.onRecorderStep!({
        ...event("click", ""),
        step: { kind: "click", target: { testId: "go" } },
      });
      result.current.recorder!.onRecorderStep!(event("type", "ab"));
    });
    expect(result.current.form!.steps).toHaveLength(3);
    expect(result.current.form!.steps[1]).toMatchObject({
      action: { kind: "type", text: "ab" },
    });
    expect(result.current.form!.steps[2]).toMatchObject({
      action: { kind: "click" },
    });
  });

  it.each([
    { enabled: false, active: true },
    { enabled: true, active: false },
  ])("rejects late captures when disabled or stopped: %j", (flags) => {
    const { result, rerender } = renderHook((props) => useFixture(props), {
      initialProps: { enabled: true, active: true },
    });
    const old = result.current.recorder!;
    rerender(flags);
    act(() => old.onRecorderStep!(event("late", "a")));
    expect(result.current.form!.steps).toHaveLength(1);
  });

  it("rejects captures from a previous case and from unresolved turns", () => {
    const { result, rerender } = renderHook((props) => useFixture(props), {
      initialProps: { caseId: "case" },
    });
    const old = result.current.recorder!;
    rerender({ caseId: "other" });
    act(() => {
      old.onRecorderStep!(event("old", "a"));
      result.current.recorder!.onRecorderStep!({
        ...event("wrong-turn", "a"),
        promptIndex: 2,
      });
    });
    expect(result.current.form!.steps).toHaveLength(1);
  });
});
