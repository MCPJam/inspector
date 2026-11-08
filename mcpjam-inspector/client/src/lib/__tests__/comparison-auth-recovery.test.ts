import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerComparisonLayout,
  registerComparisonColumn,
  prepareComparisonAuthRecovery,
  readComparisonAuthRecovery,
  clearComparisonAuthRecovery,
  markComparisonColumnSettled,
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
    markComparisonColumnSettled("p1", { kind: "model", compareId: "low" });
    expect(readComparisonAuthRecovery("p1")).not.toBeNull();
    markComparisonColumnSettled("p1", { kind: "model", compareId: "high" });
    expect(readComparisonAuthRecovery("p1")).toBeNull();
    expect(window.location.search).toBe("");
    expect(
      sessionStorage.getItem("mcp-comparison-auth-v1:restored"),
    ).toBeNull();
    lanes.forEach((unregister) => unregister());
    layout();
  });
  it("keeps an early click retryable until every column is registered", () => {
    const layout = registerComparisonLayout("loading", {
      projectId: "p1",
      multiModelEnabled: true,
      hostIds: [],
      modelSelections: [],
      selectedServers: [],
    });
    const a = registerComparisonColumn("loading", {
      compareId: "a",
      kind: "model",
      order: 0,
      chatSessionId: "a-chat",
      hasMessages: true,
    });
    expect(prepareComparisonAuthRecovery("loading", "a", "call", 2)).toEqual({
      ok: false,
      reason: "loading",
    });
    expect(window.location.search).toBe("");
    const b = registerComparisonColumn("loading", {
      compareId: "b",
      kind: "model",
      order: 1,
      chatSessionId: "b-chat",
      hasMessages: true,
    });
    expect(prepareComparisonAuthRecovery("loading", "a", "call", 2)).toEqual({
      ok: true,
    });
    expect(readComparisonAuthRecovery("p1")?.columns).toHaveLength(2);
    a();
    b();
    layout();
  });
  it("restores setups on the same client and binds the continuation to only the clicked pane", () => {
    const panes = [
      {
        paneId: "pane-a",
        target: { kind: "environment" as const, environmentId: "env-a" },
        serverIds: [],
        pluginVersionIds: [],
      },
      {
        paneId: "pane-b",
        target: { kind: "environment" as const, environmentId: "env-b" },
        serverIds: null,
        pluginVersionIds: ["pin"],
        pickedSelection: {
          source: "hosted" as const,
          modelId: "openai/model-b",
          fallback: { provider: "none" as const, model: "none" as const },
        },
      },
    ];
    const off = registerComparisonLayout("two", {
      projectId: "p1",
      multiModelEnabled: false,
      modelSelections: null,
      selectedServers: ["shared"],
      hostIds: ["client"],
      panes,
    });
    const release = panes.map((p, order) =>
      registerComparisonColumn("two", {
        compareId: p.paneId,
        kind: "host",
        order,
        chatSessionId: "child-" + order,
        hasMessages: true,
      }),
    );
    expect(
      prepareComparisonAuthRecovery("two", "pane-b", "pending-call", 2),
    ).toEqual({ ok: true });
    off();
    release.forEach((done) => done());
    const saved = readComparisonAuthRecovery("p1");
    expect(saved).toMatchObject({
      version: 2,
      panes,
      clickedColumn: "pane-b",
      continuationId: "pending-call",
      columns: [
        { compareId: "pane-a", chatSessionId: "child-0" },
        { compareId: "pane-b", chatSessionId: "child-1" },
      ],
    });
    markComparisonColumnSettled("p1", { kind: "host", compareId: "pane-b" });
    expect(readComparisonAuthRecovery("p1")).not.toBeNull();
    markComparisonColumnSettled("p1", { kind: "host", compareId: "pane-a" });
    expect(sessionStorage.getItem("mcp-comparison-auth-v2:two")).toBeNull();
  });

  it("reads a v1 redirect written by the previous client and removes its old key after restore", () => {
    sessionStorage.setItem(
      "mcp-comparison-auth-v1:old",
      JSON.stringify({
        id: "old",
        version: 1,
        projectId: "p1",
        createdAt: 1,
        continuationId: "call",
        clickedColumn: "h",
        multiModelEnabled: false,
        modelSelections: null,
        hostIds: ["h"],
        selectedServers: ["old-server"],
        columns: [
          {
            kind: "host",
            compareId: "h",
            order: 0,
            chatSessionId: "original-child",
            hasMessages: true,
          },
        ],
      }),
    );
    window.history.replaceState(
      {},
      "",
      "/p/p1/playground?comparisonRecovery=old",
    );
    expect(readComparisonAuthRecovery("local")).toMatchObject({
      version: 1,
      hostIds: ["h"],
    });
    markComparisonColumnSettled("p1", { kind: "host", compareId: "h" });
    expect(sessionStorage.getItem("mcp-comparison-auth-v1:old")).toBeNull();
  });

  it("keeps an unavailable pane's settings without inventing a child session or blocking its sibling", () => {
    const panes = ["gone", "ready"].map((id) => ({
      paneId: id,
      target: { kind: "host" as const, hostId: id },
    }));
    const layout = {
      projectId: "p1",
      multiModelEnabled: false,
      hostIds: ["gone", "ready"],
      selectedServers: [],
      modelSelections: null,
      panes,
    };
    const off = registerComparisonLayout("partial", layout);
    const release = registerComparisonColumn("partial", {
      kind: "host",
      compareId: "ready",
      order: 1,
      chatSessionId: "real",
      hasMessages: true,
    });
    expect(
      prepareComparisonAuthRecovery("partial", "ready", "call", 1),
    ).toEqual({ ok: false, reason: "loading" });
    off();
    const done = registerComparisonLayout("partial", {
      ...layout,
      unavailablePaneIds: ["gone"],
    });
    expect(
      prepareComparisonAuthRecovery("partial", "ready", "call", 1),
    ).toEqual({ ok: true });
    expect(readComparisonAuthRecovery("p1")).toMatchObject({
      panes,
      columns: [{ compareId: "ready", chatSessionId: "real" }],
    });
    markComparisonColumnSettled("p1", { kind: "host", compareId: "ready" });
    expect(readComparisonAuthRecovery("p1")).toBeNull();
    done();
    release();
  });

  it("holds sign-in while a changed lineup still has registered children from the old layout", () => {
    const off = registerComparisonLayout("changing", {
      projectId: "p1",
      multiModelEnabled: false,
      hostIds: ["same"],
      selectedServers: [],
      modelSelections: null,
      panes: [{ paneId: "new-pane", target: { kind: "host", hostId: "same" } }],
    });
    const release = registerComparisonColumn("changing", {
      kind: "host",
      compareId: "old-pane",
      order: 0,
      chatSessionId: "old-chat",
      hasMessages: true,
    });
    expect(
      prepareComparisonAuthRecovery("changing", "old-pane", "pending-call", 1),
    ).toEqual({ ok: false, reason: "loading" });
    expect(window.location.search).toBe("");
    release();
    off();
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
