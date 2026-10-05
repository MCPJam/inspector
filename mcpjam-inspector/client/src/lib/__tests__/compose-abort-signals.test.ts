import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeAbortSignals } from "../compose-abort-signals";

describe.each(["native", "fallback"])("composeAbortSignals (%s)", (support) => {
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  beforeEach(() => {
    if (support === "fallback")
      Object.defineProperty(AbortSignal, "any", {
        ...anyDescriptor,
        value: undefined,
      });
  });
  afterEach(() => {
    Object.defineProperty(AbortSignal, "any", anyDescriptor);
    vi.restoreAllMocks();
  });

  it("preserves the first abort reason without aborting other sources", () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = composeAbortSignals([first.signal, second.signal]);
    const listener = vi.fn();
    combined.signal.addEventListener("abort", listener);
    const reason = new DOMException("Cancelled", "AbortError");
    second.abort(reason);
    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBe(reason);
    expect(first.signal.aborted).toBe(false);
    first.abort(new Error("Too late"));
    expect(combined.signal.reason).toBe(reason);
    expect(listener).toHaveBeenCalledOnce();
    combined.dispose();
  });

  it("uses the first already-aborted source in input order", () => {
    const active = new AbortController();
    const first = AbortSignal.abort(new Error("First in input"));
    const second = AbortSignal.abort(new Error("Second in input"));
    const add = vi.spyOn(active.signal, "addEventListener");
    const combined = composeAbortSignals([active.signal, first, second]);
    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBe(first.reason);
    expect(add).not.toHaveBeenCalled();
    combined.dispose();
  });

  it("returns a single source unchanged", () => {
    const source = new AbortController();
    const combined = composeAbortSignals([source.signal]);
    expect(combined.signal).toBe(source.signal);
    combined.dispose();
    combined.dispose();
  });

  it("creates a non-aborted signal for an empty input", () => {
    const combined = composeAbortSignals([]);
    expect(combined.signal.aborted).toBe(false);
    combined.dispose();
  });

  if (support === "native") {
    it("delegates to the native API with its constructor as receiver", () => {
      const native = vi.spyOn(AbortSignal, "any");
      const signals = [
        new AbortController().signal,
        new AbortController().signal,
      ];
      const combined = composeAbortSignals(signals);
      expect(native).toHaveBeenCalledWith(signals);
      expect(native.mock.contexts[0]).toBe(AbortSignal);
      combined.dispose();
    });
  } else {
    it.each(["dispose", "abort"])(
      "removes all forwarding listeners on %s",
      (finish) => {
        const sources = [new AbortController(), new AbortController()];
        const adds = sources.map((source) =>
          vi.spyOn(source.signal, "addEventListener"),
        );
        const removes = sources.map((source) =>
          vi.spyOn(source.signal, "removeEventListener"),
        );
        const combined = composeAbortSignals(
          sources.map((source) => source.signal),
        );
        if (finish === "abort") sources[0].abort(new Error("Done"));
        else combined.dispose();
        for (let i = 0; i < sources.length; i++) {
          expect(removes[i]).toHaveBeenCalledExactlyOnceWith(
            "abort",
            adds[i].mock.calls[0][1],
          );
        }
        combined.dispose();
        combined.dispose();
        expect(removes.every((remove) => remove.mock.calls.length === 1)).toBe(
          true,
        );
        sources[1].abort(new Error("After cleanup"));
        expect(combined.signal.aborted).toBe(finish === "abort");
      },
    );
  }
});
