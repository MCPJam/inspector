import { beforeEach, describe, expect, it } from "vitest";
import { useSessionRefreshStore } from "../session-refresh-store";

describe("session-refresh-store", () => {
  beforeEach(() => {
    useSessionRefreshStore.setState({
      status: "idle",
      kind: null,
      retryNonce: 0,
    });
  });

  it("records a transient failure", () => {
    useSessionRefreshStore.getState().notifyFailure("transient");

    expect(useSessionRefreshStore.getState().status).toBe("failed");
    expect(useSessionRefreshStore.getState().kind).toBe("transient");
  });

  it("bumps the retry nonce so Convex re-runs setAuth", () => {
    useSessionRefreshStore.getState().notifyFailure("transient");
    useSessionRefreshStore.getState().retry();

    expect(useSessionRefreshStore.getState().status).toBe("retrying");
    expect(useSessionRefreshStore.getState().retryNonce).toBe(1);
  });

  it("clears back to idle once a token arrives", () => {
    useSessionRefreshStore.getState().notifyFailure("transient");
    useSessionRefreshStore.getState().clear();

    expect(useSessionRefreshStore.getState().status).toBe("idle");
    expect(useSessionRefreshStore.getState().kind).toBeNull();
  });

  it("never downgrades a dead session into a retryable one", () => {
    // Offering "Retry" after WorkOS rejected the session would be a button
    // that cannot possibly work.
    useSessionRefreshStore.getState().notifyFailure("signed_out");
    useSessionRefreshStore.getState().notifyFailure("transient");

    expect(useSessionRefreshStore.getState().kind).toBe("signed_out");
    expect(useSessionRefreshStore.getState().status).toBe("failed");
  });

  it("still reports a fresh signed-out failure after a clear", () => {
    useSessionRefreshStore.getState().notifyFailure("signed_out");
    useSessionRefreshStore.getState().clear();
    useSessionRefreshStore.getState().notifyFailure("transient");

    expect(useSessionRefreshStore.getState().kind).toBe("transient");
  });
});
