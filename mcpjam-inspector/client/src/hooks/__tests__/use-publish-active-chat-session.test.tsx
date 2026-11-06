import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { usePublishActiveChatSession } from "../use-publish-active-chat-session";
import { useActiveChatSessionStore as store } from "@/stores/active-chat-session-store";

afterEach(() => store.setState({ sessionId: null, appSessionScopeId: null, publisher: null, compareActive: false, viewOnly: false, restoredSession: null }));

it("publishes an atomic row continuation with no null App lifetime gap", () => {
  const hook = renderHook(({ row, scope }) => usePublishActiveChatSession(row, scope, false, false), {
    initialProps: { row: "source", scope: "lifetime" },
  });
  const seen: Array<string | null> = [];
  const off = store.subscribe((state) => seen.push(state.appSessionScopeId));
  hook.rerender({ row: "fork", scope: "lifetime" });
  expect(seen).toEqual(["lifetime"]);
  expect(store.getState()).toMatchObject({ sessionId: "fork", appSessionScopeId: "lifetime" });
  hook.rerender({ row: "source", scope: "new-lifetime" });
  expect(store.getState().appSessionScopeId).toBe("new-lifetime");
  off();
  hook.unmount();
  expect(store.getState().appSessionScopeId).toBeNull();
});

it("does not let an older publisher clear a newer publisher of the same row", () => {
  const older = renderHook(() => usePublishActiveChatSession("row", "old", false, false));
  const newer = renderHook(() => usePublishActiveChatSession("row", "new", true, true));
  older.unmount();
  expect(store.getState()).toMatchObject({ sessionId: "row", appSessionScopeId: "new", compareActive: true, viewOnly: true });
  newer.unmount();
  expect(store.getState().sessionId).toBeNull();
});

it("invalidates live App ownership on a row-only browser restoration without changing its row", () => {
  const hook = renderHook(() => usePublishActiveChatSession("row", "live", false, false));
  act(() => store.getState().setRestoredSession({ sessionId: "browser-row", origin: "api" }));
  hook.unmount();
  expect(store.getState()).toMatchObject({ sessionId: "browser-row", appSessionScopeId: null, restoredSession: { origin: "api" } });
});
