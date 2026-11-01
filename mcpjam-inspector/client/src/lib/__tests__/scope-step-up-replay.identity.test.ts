import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  savePendingDirectScopeStepUpReplay,
  setPendingDirectScopeStepUpReplayFlowDigest,
  markPendingDirectScopeStepUpReplayReady,
  peekPendingDirectScopeStepUpReplay,
  claimPendingDirectScopeStepUpReplay,
  clearPendingDirectScopeStepUpReplay,
} from "../scope-step-up-replay";
const save = (callId: string) => {
  savePendingDirectScopeStepUpReplay({
    operation: {
      resourceUrl: "https://example.test/mcp",
      method: "tools/call",
      operation: "read",
    },
    descriptor: {
      kind: "tool",
      surface: "tools",
      serverName: "same",
      toolName: "read",
      parameters: {},
      authAttempt: {
        projectId: "p1",
        serverId: "same",
        surface: "tools",
        callId,
      },
    },
  });
  setPendingDirectScopeStepUpReplayFlowDigest("same", "flow-" + callId);
};
describe("direct replay identity", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/p/p1/tools");
  });
  it("does not replay the same server name in another project", () => {
    save("a");
    markPendingDirectScopeStepUpReplayReady("same", "flow-a");
    window.history.replaceState({}, "", "/p/p2/tools");
    expect(
      claimPendingDirectScopeStepUpReplay({
        serverName: "same",
        surface: "tools",
      }),
    ).toBeUndefined();
    window.history.replaceState({}, "", "/p/p1/tools");
    expect(
      claimPendingDirectScopeStepUpReplay({
        serverName: "same",
        surface: "tools",
      }),
    ).toBeDefined();
  });
  it("marks a call saved without a flow binding ready on the server's next sign-in", () => {
    savePendingDirectScopeStepUpReplay({
      operation: {
        resourceUrl: "https://example.test/mcp",
        method: "tools/call",
        operation: "read",
      },
      descriptor: {
        kind: "tool",
        surface: "tools",
        serverName: "same",
        toolName: "read",
        parameters: {},
      },
    });
    markPendingDirectScopeStepUpReplayReady("same", "any-flow");
    expect(
      claimPendingDirectScopeStepUpReplay({
        serverName: "same",
        surface: "tools",
      }),
    ).toBeDefined();
  });
  it("requires a flow digest and cannot rearm an already claimed call", () => {
    save("a");
    markPendingDirectScopeStepUpReplayReady("same");
    expect(
      claimPendingDirectScopeStepUpReplay({
        serverName: "same",
        surface: "tools",
      }),
    ).toBeUndefined();
    clearPendingDirectScopeStepUpReplay(peekPendingDirectScopeStepUpReplay()!);
    save("b");
    markPendingDirectScopeStepUpReplayReady("same", "flow-b");
    expect(
      claimPendingDirectScopeStepUpReplay({
        serverName: "same",
        surface: "tools",
      }),
    ).toBeDefined();
    markPendingDirectScopeStepUpReplayReady("same", "flow-b");
    expect(
      claimPendingDirectScopeStepUpReplay({
        serverName: "same",
        surface: "tools",
      }),
    ).toBeUndefined();
  });
  it("preserves the call and expiry across a second flow, despite old cleanup", () => {
    save("a");
    markPendingDirectScopeStepUpReplayReady("same", "flow-a");
    const first = claimPendingDirectScopeStepUpReplay({ serverName: "same", surface: "tools" })!;
    savePendingDirectScopeStepUpReplay({
      operation: first.operation, descriptor: first.descriptor, previous: first,
    });
    const next = peekPendingDirectScopeStepUpReplay()!;
    expect(next.callId).toBe(first.callId);
    expect(next.generation).toBe(first.generation! + 1);
    expect(next.expiresAt).toBe(first.expiresAt);
    expect(next.flowDigest).toBeUndefined();
    clearPendingDirectScopeStepUpReplay(first);
    expect(peekPendingDirectScopeStepUpReplay()).toEqual(next);
    setPendingDirectScopeStepUpReplayFlowDigest("same", "second-flow");
    markPendingDirectScopeStepUpReplayReady("same", "flow-a");
    expect(peekPendingDirectScopeStepUpReplay()?.phase).toBe("awaiting_oauth");
    markPendingDirectScopeStepUpReplayReady("same", "second-flow");
    expect(claimPendingDirectScopeStepUpReplay({ serverName: "same", surface: "tools" })).toBeDefined();
    expect(claimPendingDirectScopeStepUpReplay({ serverName: "same", surface: "tools" })).toBeUndefined();
  });
  it("an old flow cannot bind or clear a newer generation", () => {
    save("a");
    markPendingDirectScopeStepUpReplayReady("same", "flow-a");
    const first = claimPendingDirectScopeStepUpReplay({ serverName: "same", surface: "tools" })!;
    const next = savePendingDirectScopeStepUpReplay({ operation: first.operation, descriptor: first.descriptor, previous: first });
    expect(() => setPendingDirectScopeStepUpReplayFlowDigest("same", "old", first)).toThrow();
    setPendingDirectScopeStepUpReplayFlowDigest("same", "new", next);
    clearPendingDirectScopeStepUpReplay(first);
    expect(peekPendingDirectScopeStepUpReplay()?.flowDigest).toBe("new");
  });
  it("rejects a silently failed save", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
    try { expect(() => save("a")).toThrow(); } finally { spy.mockRestore(); }
  });
  it("does not extend an expired call for another flow", () => {
    save("a");
    markPendingDirectScopeStepUpReplayReady("same", "flow-a");
    const first = claimPendingDirectScopeStepUpReplay({ serverName: "same", surface: "tools" })!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(first.expiresAt + 1);
    try {
      expect(() => savePendingDirectScopeStepUpReplay({ operation: first.operation, descriptor: first.descriptor, previous: first })).toThrow();
      expect(peekPendingDirectScopeStepUpReplay()).toBeUndefined();
    } finally { clock.mockRestore(); }
  });
  it("rejects unavailable storage without leaking inputs", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    try { expect(() => save("a")).toThrow(); } finally { spy.mockRestore(); }
  });
  it("an old request finishing cannot clean up a newer pending call", () => {
    save("a");
    const old = peekPendingDirectScopeStepUpReplay()!;
    expect(() => save("b")).toThrow("Another call is waiting");
    expect(peekPendingDirectScopeStepUpReplay()).toEqual(old);
    clearPendingDirectScopeStepUpReplay(old);
    save("b");
    clearPendingDirectScopeStepUpReplay(old);
    expect(
      peekPendingDirectScopeStepUpReplay()?.descriptor.authAttempt?.callId,
    ).toBe("b");
  });
});
