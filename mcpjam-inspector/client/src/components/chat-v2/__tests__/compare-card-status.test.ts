import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MultiModelCardStatus } from "../model-compare-card-header";
import { useCompareCardStatus } from "../compare-card-status";

type Props = Parameters<typeof useCompareCardStatus>[0];

function renderStatus(initial: Partial<Props>, aborted: boolean[] = []) {
  const consumeTurnAborted = vi.fn(() => aborted.shift() ?? false);
  const seen: MultiModelCardStatus[] = [];
  const props = (overrides: Partial<Props>): Props => ({
    failed: false,
    isStreaming: false,
    isThreadEmpty: false,
    consumeTurnAborted,
    ...overrides,
  });
  const hook = renderHook(
    (value: Props) => {
      const status = useCompareCardStatus(value);
      seen.push(status);
      return status;
    },
    { initialProps: props(initial) },
  );
  return {
    ...hook,
    seen,
    consumeTurnAborted,
    update: (overrides: Partial<Props>) => hook.rerender(props(overrides)),
  };
}

describe("useCompareCardStatus", () => {
  it("reports a stopped stream as cancelled, and never as ready on the way", () => {
    const card = renderStatus({ isStreaming: true }, [true]);
    expect(card.result.current).toBe("running");

    card.update({ isStreaming: false });

    expect(card.result.current).toBe("cancelled");
    expect(card.seen).not.toContain("ready");
    expect(card.consumeTurnAborted).toHaveBeenCalledTimes(1);
  });

  it("reports a stream that finished as ready", () => {
    const card = renderStatus({ isStreaming: true }, [false]);
    card.update({ isStreaming: false });
    expect(card.result.current).toBe("ready");
  });

  it("forgets the stop once the next turn finishes", () => {
    const card = renderStatus({ isStreaming: true }, [true, false]);
    card.update({ isStreaming: false });
    expect(card.result.current).toBe("cancelled");

    card.update({ isStreaming: true });
    expect(card.result.current).toBe("running");
    card.update({ isStreaming: false });
    expect(card.result.current).toBe("ready");
  });

  it("forgets the stop when the thread is cleared", () => {
    const card = renderStatus({ isStreaming: true }, [true]);
    card.update({ isStreaming: false });
    card.update({ isThreadEmpty: true });
    expect(card.result.current).toBe("idle");

    card.update({ isThreadEmpty: false });
    expect(card.result.current).toBe("ready");
  });

  it("asks the session only when a stream ends", () => {
    const card = renderStatus({});
    card.update({ isThreadEmpty: true });
    expect(card.result.current).toBe("idle");
    expect(card.consumeTurnAborted).not.toHaveBeenCalled();
  });

  it("puts a failure first and keeps other work running", () => {
    expect(
      renderStatus({ failed: true, isStreaming: true }).result.current,
    ).toBe("error");
    expect(renderStatus({ isBusy: true }).result.current).toBe("running");
  });
});
