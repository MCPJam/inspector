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

beforeEach(() => {
  clearAllSessions();
});

describe("createSession", () => {
  it("creates a session with authorization URL", () => {
    const session = createSession("https://auth.example.com/authorize", "state123");
    expect(session.id).toBeTruthy();
    expect(session.authorizationUrl).toBe("https://auth.example.com/authorize");
    expect(session.expectedState).toBe("state123");
    expect(session.completedSteps).toEqual([]);
  });

  it("generates unique session IDs", () => {
    const s1 = createSession("https://a.com", "s1");
    const s2 = createSession("https://b.com", "s2");
    expect(s1.id).not.toBe(s2.id);
  });
});

describe("getSession", () => {
  it("returns undefined for nonexistent session", () => {
    expect(getSession("nonexistent")).toBeUndefined();
  });

  it("returns session by ID", () => {
    const created = createSession("https://a.com");
    const found = getSession(created.id);
    expect(found).toBe(created);
  });
});

describe("deleteSession", () => {
  it("removes session", () => {
    const session = createSession("https://a.com");
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

  it("returns false when session has no resolver", () => {
    const session = createSession("https://a.com");
    // No resolver set
    expect(submitAuthorizationCode(session.id, "code123")).toBe(false);
  });

  it("delivers code to resolver", async () => {
    const session = createSession("https://a.com", "state123");
    const codePromise = new Promise<{ code: string; state?: string }>((resolve) => {
      session.codeResolver = resolve;
    });

    const delivered = submitAuthorizationCode(session.id, "auth-code", "state123");
    expect(delivered).toBe(true);

    const result = await codePromise;
    expect(result.code).toBe("auth-code");
    expect(result.state).toBe("state123");
  });
});

describe("addCompletedStep", () => {
  it("adds step to session", () => {
    const session = createSession("https://a.com");
    addCompletedStep(session.id, "metadata_discovery", "passed");
    expect(session.completedSteps).toEqual([
      { step: "metadata_discovery", status: "passed" },
    ]);
  });

  it("does not throw for nonexistent session", () => {
    expect(() => addCompletedStep("nonexistent", "step", "passed")).not.toThrow();
  });
});

describe("setSessionResult", () => {
  it("stores result on session", () => {
    const session = createSession("https://a.com");
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
  it("stores error on session", () => {
    const session = createSession("https://a.com");
    setSessionError(session.id, "Connection failed");
    expect(session.error).toBe("Connection failed");
  });
});

describe("clearAllSessions", () => {
  it("removes all sessions", () => {
    const s1 = createSession("https://a.com");
    const s2 = createSession("https://b.com");
    clearAllSessions();
    expect(getSession(s1.id)).toBeUndefined();
    expect(getSession(s2.id)).toBeUndefined();
  });
});
