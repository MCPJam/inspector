import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSavedClientSendGuard } from "../use-saved-client-send-guard";

describe("saved client send preparation", () => {
  it("refuses a delayed send even when configuration changes back", async () => {
    const { result, rerender } = renderHook(useSavedClientSendGuard, {
      initialProps: "client-a:prompt-one",
    });
    let release: () => void = () => { throw new Error("Missing preparation"); };
    const prepared = new Promise<void>((resolve) => { release = resolve; });
    const current = result.current.begin();
    const send = prepared.then(() => current());
    rerender("client-a:prompt-two");
    rerender("client-a:prompt-one");
    release();
    expect(await send).toBe(false);
    expect(() => result.current.assertCurrent()).toThrow("settings changed");
    expect(result.current.begin()()).toBe(true);
    expect(() => result.current.assertCurrent()).not.toThrow();
  });

  it("invalidates preparation on stop and removal", () => {
    const { result, unmount } = renderHook(() => useSavedClientSendGuard("a"));
    const stopped = result.current.begin();
    act(() => result.current.cancel());
    expect(stopped()).toBe(false);
    const removed = result.current.begin();
    unmount();
    expect(removed()).toBe(false);
    expect(() => result.current.assertCurrent()).toThrow("settings changed");
  });

  it("does not cancel a sibling or ordinary rerenders", () => {
    const a = renderHook(useSavedClientSendGuard, { initialProps: "a" });
    const b = renderHook(useSavedClientSendGuard, { initialProps: "b" });
    const aCurrent = a.result.current.begin();
    const bCurrent = b.result.current.begin();
    a.rerender("a");
    expect(aCurrent()).toBe(true);
    a.rerender("changed");
    expect(aCurrent()).toBe(false);
    expect(bCurrent()).toBe(true);
  });
});
