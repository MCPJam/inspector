import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerComparisonLayout,
  registerComparisonColumn,
  prepareComparisonAuthRecovery,
  readComparisonAuthRecovery,
  clearComparisonAuthRecovery,
  markComparisonColumnRestored,
} from "../comparison-auth-recovery";

describe("comparison OAuth restoration", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/p/p1/playground");
  });
  it("saves both same-model columns and binds the clicked call", () => {
    const layout = registerComparisonLayout("group", {
      projectId: "p1",
      multiModelEnabled: true,
      hostIds: [],
      modelSelections: [],
      selectedServers: ["bench"],
    });
    const a = registerComparisonColumn("group", {
      compareId: "low",
      kind: "model",
      order: 0,
      chatSessionId: "chat-low",
      hasMessages: true,
    });
    const b = registerComparisonColumn("group", {
      compareId: "high",
      kind: "model",
      order: 1,
      chatSessionId: "chat-high",
      hasMessages: true,
    });
    expect(prepareComparisonAuthRecovery("group", "low", "call1")).toEqual({
      ok: true,
    });
    expect(readComparisonAuthRecovery("p1")).toMatchObject({
      continuationId: "call1",
      clickedColumn: "low",
      columns: [{ chatSessionId: "chat-low" }, { chatSessionId: "chat-high" }],
    });
    expect(readComparisonAuthRecovery("p2")).toBeNull();
    clearComparisonAuthRecovery();
    expect(readComparisonAuthRecovery("p1")).toBeNull();
    a();
    b();
    layout();
  });
  it("clears the saved comparison once every column has restored", () => {
    const layout = registerComparisonLayout("restored", {
      projectId: "p1",
      multiModelEnabled: true,
      hostIds: [],
      modelSelections: [],
      selectedServers: [],
    });
    const lanes = ["low", "high"].map((compareId, order) =>
      registerComparisonColumn("restored", {
        compareId,
        kind: "model",
        order,
        chatSessionId: `chat-${compareId}`,
        hasMessages: true,
      }),
    );
    expect(prepareComparisonAuthRecovery("restored", "low", "call1")).toEqual({
      ok: true,
    });
    markComparisonColumnRestored("p1", { kind: "model", compareId: "low" });
    expect(readComparisonAuthRecovery("p1")).not.toBeNull();
    markComparisonColumnRestored("p1", { kind: "model", compareId: "high" });
    expect(readComparisonAuthRecovery("p1")).toBeNull();
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem("mcp-comparison-auth-v1:restored")).toBeNull();
    lanes.forEach((unregister) => unregister());
    layout();
  });
  it("keeps an early click retryable until every column is registered", () => {
    const layout = registerComparisonLayout("loading", {
      projectId: "p1", multiModelEnabled: true, hostIds: [], modelSelections: [], selectedServers: [],
    });
    const a = registerComparisonColumn("loading", {
      compareId: "a", kind: "model", order: 0, chatSessionId: "a-chat", hasMessages: true,
    });
    expect(prepareComparisonAuthRecovery("loading", "a", "call", 2)).toEqual({ ok: false, reason: "loading" });
    expect(window.location.search).toBe("");
    const b = registerComparisonColumn("loading", {
      compareId: "b", kind: "model", order: 1, chatSessionId: "b-chat", hasMessages: true,
    });
    expect(prepareComparisonAuthRecovery("loading", "a", "call", 2)).toEqual({ ok: true });
    expect(readComparisonAuthRecovery("p1")?.columns).toHaveLength(2);
    a(); b(); layout();
  });
  it("refuses navigation if the comparison cannot be saved", () => {
    const l = registerComparisonLayout("group", {
      projectId: "p1",
      multiModelEnabled: true,
      hostIds: [],
      modelSelections: [],
      selectedServers: [],
    });
    const c = registerComparisonColumn("group", {
      compareId: "a",
      kind: "model",
      order: 0,
      chatSessionId: "chat-a",
      hasMessages: true,
    });
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("full");
      });
    expect(prepareComparisonAuthRecovery("group", "a", "call1")).toEqual({
      ok: false,
      reason: "storage",
    });
    expect(window.location.search).toBe("");
    spy.mockRestore();
    c();
    l();
  });
});
