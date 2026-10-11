// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useInitialRenderOutcome } from "../use-initial-render-outcome";

describe("initial App render outcome", () => {
  it("waits for readiness and ignores subsequent failures and rerenders", () => {
    const notify = vi.fn();
    const hook = renderHook(
      ({ ready, failed }) => useInitialRenderOutcome(ready, failed, notify),
      {
        initialProps: { ready: false, failed: false },
      }
    );
    expect(notify).not.toHaveBeenCalled();
    hook.rerender({ ready: true, failed: false });
    hook.rerender({ ready: false, failed: true });
    expect(notify.mock.calls).toEqual([["ready"]]);
  });
  it("reports an initial failure once without copying diagnostic content", () => {
    const notify = vi.fn();
    const hook = renderHook(
      ({ ready }) => useInitialRenderOutcome(ready, true, notify),
      { initialProps: { ready: false } }
    );
    hook.rerender({ ready: true });
    expect(notify.mock.calls).toEqual([["error"]]);
  });
  it("isolates observer failures and accepts a late observer", () => {
    const notify = vi.fn(() => {
      throw new Error("offline");
    });
    const hook = renderHook(
      ({ callback }) => useInitialRenderOutcome(true, false, callback),
      {
        initialProps: { callback: undefined as typeof notify | undefined },
      }
    );
    expect(() => hook.rerender({ callback: notify })).not.toThrow();
    hook.rerender({ callback: vi.fn() });
    expect(notify).toHaveBeenCalledOnce();
  });
});
