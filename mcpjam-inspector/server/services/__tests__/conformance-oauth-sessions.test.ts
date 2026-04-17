import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  getSession,
  deleteSession,
  submitAuthorizationCode,
  addCompletedStep,
  setSessionResult,
  setSessionError,
  clearAllSessions,
} from "../conformance-oauth-sessions.js";
import type { ConformanceResult } from "@mcpjam/sdk";

const REDIRECT = "https://inspector.example/oauth/callback/debug";

beforeEach(() => {
  clearAllSessions();
});

describe("createSession", () => {
  it("creates a session wrapping an SDK controller", () => {
    const session = createSession({ redirectUrl: REDIRECT });
    expect(session.id).toBeTruthy();
    expect(session.controller).toBeDefined();
    expect(session.authorizationUrl).toBeUndefined();
    expect(session.completedSteps).toEqual([]);
  });

  it("generates unique session IDs", () => {
    const s1 = createSession({ redirectUrl: REDIRECT });
    const s2 = createSession({ redirectUrl: REDIRECT });
    expect(s1.id).not.toBe(s2.id);
  });

  it("mirrors the auth URL onto the session once the runner surfaces it", async () => {
    const session = createSession({ redirectUrl: REDIRECT });
    const sdkSession = await session.controller.createSession();
    // Not awaited on purpose — the production runner awaits its own copy.
    // Attach a no-op handler to avoid the subsequent clearAllSessions() fail
    // propagating here as an unhandled rejection.
    sdkSession
      .authorize({
        authorizationUrl: "https://auth.example/authorize",
        timeoutMs: 5_000,
      })
      .catch(() => undefined);
    await session.controller.awaitAuthorizationUrl;
    expect(session.authorizationUrl).toBe("https://auth.example/authorize");
  });
});

describe("getSession", () => {
  it("returns undefined for nonexistent session", () => {
    expect(getSession("nonexistent")).toBeUndefined();
  });

  it("returns session by ID", () => {
    const created = createSession({ redirectUrl: REDIRECT });
    const found = getSession(created.id);
    expect(found).toBe(created);
  });
});

describe("deleteSession", () => {
  it("removes session", () => {
    const session = createSession({ redirectUrl: REDIRECT });
    deleteSession(session.id);
    expect(getSession(session.id)).toBeUndefined();
  });

  it("does not throw for nonexistent session", () => {
    expect(() => deleteSession("nonexistent")).not.toThrow();
  });
});

describe("submitAuthorizationCode", () => {
  it("returns false for nonexistent session", () => {
    expect(submitAuthorizationCode("nonexistent", "code123")).toBe(false);
  });

  it("delivers code through the SDK controller to a pending authorize", async () => {
    const session = createSession({ redirectUrl: REDIRECT });
    const sdkSession = await session.controller.createSession();

    const codePromise = sdkSession.authorize({
      authorizationUrl: "https://auth.example/authorize?state=s1",
      expectedState: "s1",
      timeoutMs: 5_000,
    });

    const delivered = submitAuthorizationCode(session.id, "auth-code", "s1");
    expect(delivered).toBe(true);

    await expect(codePromise).resolves.toEqual({ code: "auth-code" });
  });
});

describe("addCompletedStep", () => {
  it("adds step to session", () => {
    const session = createSession({ redirectUrl: REDIRECT });
    addCompletedStep(session.id, "metadata_discovery", "passed");
    expect(session.completedSteps).toEqual([
      { step: "metadata_discovery", status: "passed" },
    ]);
  });

  it("does not throw for nonexistent session", () => {
    expect(() =>
      addCompletedStep("nonexistent", "step", "passed"),
    ).not.toThrow();
  });
});

describe("setSessionResult", () => {
  it("stores result on session", () => {
    const session = createSession({ redirectUrl: REDIRECT });
    const result = {
      passed: true,
      protocolVersion: "2025-11-25" as const,
      registrationStrategy: "cimd" as const,
      serverUrl: "https://a.com",
      steps: [],
      summary: "All checks passed",
      durationMs: 100,
    } as ConformanceResult;

    setSessionResult(session.id, result);
    expect(session.result).toBe(result);
  });
});

describe("setSessionError", () => {
  it("stores error on session and fails the controller", async () => {
    const session = createSession({ redirectUrl: REDIRECT });
    setSessionError(session.id, "Connection failed");
    expect(session.error).toBe("Connection failed");
    await expect(session.controller.awaitAuthorizationUrl).rejects.toThrow(
      "Connection failed",
    );
  });
});

describe("clearAllSessions", () => {
  it("removes all sessions", () => {
    const s1 = createSession({ redirectUrl: REDIRECT });
    const s2 = createSession({ redirectUrl: REDIRECT });
    clearAllSessions();
    expect(getSession(s1.id)).toBeUndefined();
    expect(getSession(s2.id)).toBeUndefined();
  });
});
