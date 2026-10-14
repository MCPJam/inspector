import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerComparisonLayout,
  registerComparisonColumn,
  prepareComparisonAuthRecovery,
  readComparisonAuthRecovery,
  clearComparisonAuthRecovery,
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
