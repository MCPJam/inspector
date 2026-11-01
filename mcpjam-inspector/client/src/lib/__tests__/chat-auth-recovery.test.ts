import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimPendingChatScopeStepUp,
  clearPendingChatScopeStepUp,
  listPendingChatScopeStepUps,
  preparePendingChatAuthRequired,
  readPendingChatScopeStepUp,
  savePendingChatScopeStepUp,
  setPendingChatScopeStepUpFlowDigest,
  settlePendingChatScopeStepUpAfterCallback,
  cancelPendingChatScopeStepUpForCallback,
} from "../scope-step-up-pending";
import {
  claimMissingCallCancellation,
  clearChatAuthRecoveryFailure,
  dismissChatAuthRecoveryFailure,
  recordChatAuthRecoveryFailure,
  traceChatAuthRecovery,
  useChatAuthRecoveryFailures,
} from "../chat-auth-recovery";
import type { AuthRequiredEvent } from "@/shared/auth-challenge";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("../sentry", () => ({ captureSentryMessage: capture }));
const KEY = "mcp-scope-step-up-chat-v2";
function input(id = "a", serverName = "same", projectId = "p1") {
  return {
    event: {
      version: 1,
      kind: "auth_required",
      continuationId: id,
      serverId: serverName,
      serverName,
      toolCallId: `tool-${id}`,
      operation: { method: "tools/call", operation: "bench_read" },
      source: "http_401",
      effectiveAuth: "discover",
      action: "prompt",
      readOnly: true,
      expiresAt: Date.now() + 60_000,
    } satisfies AuthRequiredEvent & { continuationId: string },
    serverName,
    chatSessionId: `chat-${id}`,
    projectId,
    phase: "awaiting_click" as const,
  };
}
function start(id = "a", serverName = "same", projectId = "p1") {
  const value = input(id, serverName, projectId);
  expect(savePendingChatScopeStepUp(value)).toEqual({ ok: true });
  expect(preparePendingChatAuthRequired(value)).toEqual({ ok: true });
  expect(
    setPendingChatScopeStepUpFlowDigest(serverName, `digest-${id}`, id),
  ).toBe(true);
  return value;
}
beforeEach(() => {
  vi.restoreAllMocks();
  capture.mockClear();
  sessionStorage.clear();
});

describe("chat sign-in recovery", () => {
  it("keeps same-name calls in different projects and model lanes separate", () => {
    start("a", "same", "p1");
    start("b", "same", "p2");
    expect(
      settlePendingChatScopeStepUpAfterCallback("same", undefined, "digest-a"),
    ).toEqual({ kind: "ready" });
    expect(claimPendingChatScopeStepUp("chat-b", "a")).toBeUndefined();
    expect(
      claimPendingChatScopeStepUp("chat-a", "a")?.event.continuationId,
    ).toBe("a");
    expect(claimPendingChatScopeStepUp("chat-a", "a")).toBeUndefined();
    clearPendingChatScopeStepUp("a");
    expect(readPendingChatScopeStepUp({ continuationId: "b" })?.phase).toBe(
      "awaiting_oauth",
    );
  });
  it("can click an older visible card without touching the newer card", () => {
    const a = input("a", "one");
    const b = input("b", "two");
    savePendingChatScopeStepUp(a);
    savePendingChatScopeStepUp(b);
    expect(preparePendingChatAuthRequired(a)).toEqual({ ok: true });
    expect(readPendingChatScopeStepUp({ continuationId: "b" })?.phase).toBe(
      "awaiting_click",
    );
  });
  it("repairs a lost card-time write from the clicked card and reports it once", () => {
    const value = input();
    expect(preparePendingChatAuthRequired(value)).toEqual({ ok: true });
    expect(readPendingChatScopeStepUp({ continuationId: "a" })).toMatchObject({
      phase: "awaiting_oauth",
      projectId: "p1",
    });
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it("refuses to redirect when the saved call cannot be written", () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(
      function (key, value) {
        if (key === KEY) throw new DOMException("quota", "QuotaExceededError");
        original.call(this, key, value);
      },
    );
    expect(preparePendingChatAuthRequired(input()).ok).toBe(false);
    expect(readPendingChatScopeStepUp()).toBeUndefined();
  });
  it("detects writes silently discarded by storage", () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(
      function (key, value) {
        if (key !== KEY) original.call(this, key, value);
      },
    );
    expect(savePendingChatScopeStepUp(input())).toEqual({
      ok: false,
      reason: "storage",
    });
  });
  it("keeps enough click context to report a missing row after a redirect", () => {
    start();
    sessionStorage.removeItem(KEY);
    expect(
      settlePendingChatScopeStepUpAfterCallback("same", undefined, "digest-a")
        .kind,
    ).toBe("failed");
    const { result } = renderHook(useChatAuthRecoveryFailures);
    expect(result.current).toContainEqual(
      expect.objectContaining({
        reason: "missing_pending",
        chatSessionId: "chat-a",
        toolCallId: "tool-a",
        continuationId: "a",
      }),
    );
  });
  it("never accepts a wrong flow for the explicitly identified call", () => {
    start();
    expect(
      settlePendingChatScopeStepUpAfterCallback("same", undefined, "wrong", "a")
        .kind,
    ).toBe("ignored");
    expect(readPendingChatScopeStepUp({ continuationId: "a" })?.phase).toBe(
      "awaiting_oauth",
    );
  });
  it("does not resume a call when neither side has a flow digest", () => {
    const value = input();
    expect(savePendingChatScopeStepUp(value)).toEqual({ ok: true });
    expect(preparePendingChatAuthRequired(value)).toEqual({ ok: true });
    expect(
      settlePendingChatScopeStepUpAfterCallback("same", undefined, undefined)
        .kind,
    ).toBe("failed");
    expect(readPendingChatScopeStepUp({ continuationId: "a" })?.phase).not.toBe(
      "ready",
    );
  });
  it("keeps only the most recent failures", () => {
    for (let index = 0; index < 60; index += 1)
      recordChatAuthRecoveryFailure("resume_failed", {
        continuationId: `cont-${index}`,
      });
    const notices = renderHook(useChatAuthRecoveryFailures);
    expect(notices.result.current).toHaveLength(50);
    expect(notices.result.current.at(-1)?.continuationId).toBe("cont-59");
  });
  it("ignores unrelated sign-ins instead of cancelling a different chat", () => {
    start();
    expect(
      settlePendingChatScopeStepUpAfterCallback(
        "other",
        undefined,
        "other-flow",
      ),
    ).toEqual({ kind: "ignored" });
    expect(
      settlePendingChatScopeStepUpAfterCallback(
        "same",
        undefined,
        "other-flow",
      ),
    ).toEqual({ kind: "ignored" });
    expect(readPendingChatScopeStepUp()?.phase).toBe("awaiting_oauth");
    expect(capture).not.toHaveBeenCalled();
  });
  it("rejects a matching flow returned for the wrong server", () => {
    start();
    expect(
      settlePendingChatScopeStepUpAfterCallback("other", undefined, "digest-a")
        .kind,
    ).toBe("failed");
    expect(readPendingChatScopeStepUp()?.phase).toBe("cancelled");
  });
  it("does not replay an expired continuation", () => {
    start();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    expect(
      settlePendingChatScopeStepUpAfterCallback("same", undefined, "digest-a")
        .kind,
    ).toBe("failed");
    expect(claimPendingChatScopeStepUp("chat-a")).toBeUndefined();
  });
  it("cancels only the denied flow and does not page for normal cancellation", () => {
    start("a");
    start("b");
    expect(
      cancelPendingChatScopeStepUpForCallback(
        "same",
        "User cancelled",
        "digest-b",
      ),
    ).toBe(true);
    expect(readPendingChatScopeStepUp({ continuationId: "a" })?.phase).toBe(
      "awaiting_oauth",
    );
    expect(readPendingChatScopeStepUp({ continuationId: "b" })?.phase).toBe(
      "cancelled",
    );
    expect(capture).not.toHaveBeenCalled();
  });
  it("migrates a legacy call without changing its identity, binding, or expiry", () => {
    const value = input();
    const old = {
      ...value,
      version: 1,
      phase: "awaiting_oauth",
      returnPath: "/chat",
      createdAt: 10,
      flowDigest: "old-flow",
      credentialBinding: { kind: "none" },
    };
    sessionStorage.setItem("mcp-scope-step-up-chat-v1", JSON.stringify(old));
    expect(readPendingChatScopeStepUp()).toEqual(old);
    expect(sessionStorage.getItem("mcp-scope-step-up-chat-v1")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(KEY)!)).toEqual({
      version: 2,
      entries: [old],
    });
  });
  it("does not erase legacy data when migration storage fails", () => {
    const old = { ...input(), version: 1, returnPath: "/chat", createdAt: 10 };
    sessionStorage.setItem("mcp-scope-step-up-chat-v1", JSON.stringify(old));
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(
      function (key, value) {
        if (key === KEY) throw new Error("denied");
        original.call(this, key, value);
      },
    );
    expect(listPendingChatScopeStepUps()).toHaveLength(1);
    expect(sessionStorage.getItem("mcp-scope-step-up-chat-v1")).not.toBeNull();
  });
  it("persists notices, dismissal, and report deduplication across remounts", () => {
    const context = {
      continuationId: "a",
      toolCallId: "tool-a",
      chatSessionId: "chat-a",
    };
    recordChatAuthRecoveryFailure("resume_failed", context);
    const first = renderHook(useChatAuthRecoveryFailures);
    const id = first.result.current[0].id;
    act(() => dismissChatAuthRecoveryFailure(id));
    first.unmount();
    const second = renderHook(useChatAuthRecoveryFailures);
    expect(second.result.current[0].dismissed).toBe(true);
    act(() => recordChatAuthRecoveryFailure("resume_failed", context));
    expect(capture).toHaveBeenCalledTimes(1);
    act(() => clearChatAuthRecoveryFailure("tool-a"));
    expect(second.result.current).toEqual([]);
  });
  it("bounds history and only reports allowlisted debugging fields", () => {
    const context = {
      continuationId: "a",
      flowDigest: "12345678SECRET",
      token: "SECRET",
      rawState: "SECRET",
      toolArguments: { private: "SECRET" },
    };
    for (let i = 0; i < 100; i++) traceChatAuthRecovery("save", context);
    recordChatAuthRecoveryFailure("save_failed", context);
    const event = capture.mock.calls[0][1];
    expect(event.tags.source).toBe("chat_auth_resume");
    expect(event.extra.history).toHaveLength(80);
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });
});

it("a Back-button retry replaces its old flow binding without extending expiry", () => {
  const value = start();
  const expiry = readPendingChatScopeStepUp({ continuationId: "a" })!.event.expiresAt;
  expect(preparePendingChatAuthRequired(value)).toEqual({ ok: true });
  expect(readPendingChatScopeStepUp({ continuationId: "a" })?.flowDigest).toBeUndefined();
  expect(setPendingChatScopeStepUpFlowDigest("same", "new-flow", "a")).toBe(true);
  expect(settlePendingChatScopeStepUpAfterCallback("same", undefined, "digest-a")).toEqual({ kind: "ignored" });
  expect(readPendingChatScopeStepUp({ continuationId: "a" })?.event.expiresAt).toBe(expiry);
});

it("persists missing-call cancellation before dispatch and refuses when storage fails", () => {
  sessionStorage.clear();
  expect(claimMissingCallCancellation("lost-call")).toBe(true);
  expect(claimMissingCallCancellation("lost-call")).toBe(false);
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
  expect(claimMissingCallCancellation("other-call")).toBe(false);
  spy.mockRestore();
});

it("preserves the new flow when the old callback fails, then resumes the new flow once", () => {
  const value = start();
  preparePendingChatAuthRequired(value);
  setPendingChatScopeStepUpFlowDigest("same", "new-flow", "a");
  const before = readPendingChatScopeStepUp({ continuationId: "a" });
  expect(cancelPendingChatScopeStepUpForCallback("same", "state mismatch", "digest-a", "a")).toBe(false);
  expect(settlePendingChatScopeStepUpAfterCallback("same", undefined, "digest-a", "a")).toEqual({ kind: "ignored" });
  expect(readPendingChatScopeStepUp({ continuationId: "a" })).toEqual(before);
  expect(capture).not.toHaveBeenCalled();
  expect(settlePendingChatScopeStepUpAfterCallback("same", undefined, "new-flow", "a")).toEqual({ kind: "ready" });
  expect(claimPendingChatScopeStepUp("chat-a", "a")).toBeDefined();
  expect(claimPendingChatScopeStepUp("chat-a", "a")).toBeUndefined();
});

it("ignores a stale failure while a new flow is being prepared", () => {
  const value = start();
  preparePendingChatAuthRequired(value);
  expect(cancelPendingChatScopeStepUpForCallback("same", "denied", "digest-a", "a")).toBe(false);
  expect(readPendingChatScopeStepUp()?.phase).toBe("awaiting_oauth");
  setPendingChatScopeStepUpFlowDigest("same", "new-flow", "a");
  expect(cancelPendingChatScopeStepUpForCallback("same", "denied", "new-flow", "a")).toBe(true);
  expect(readPendingChatScopeStepUp()?.phase).toBe("cancelled");
});
