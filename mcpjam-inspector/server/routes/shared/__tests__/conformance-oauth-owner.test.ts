import { afterEach, describe, expect, it } from "vitest";
import type { ConformanceResult } from "@mcpjam/sdk";
import {
  OAuthConformanceSessionNotFoundError,
  completeOAuthConformance,
  submitOAuthConformanceCode,
} from "../conformance.js";
import {
  clearAllSessions,
  createSession,
  setSessionResult,
} from "../../../services/conformance-oauth-sessions.js";

const REDIRECT = "https://inspector.example/oauth/callback/debug";
const RESULT = { passed: true, steps: [] } as unknown as ConformanceResult;

afterEach(() => {
  clearAllSessions();
});

describe("OAuth conformance session owner", () => {
  it("gives the result to the caller that started the run", async () => {
    const session = createSession({ redirectUrl: REDIRECT, owner: "user:a" });
    setSessionResult(session.id, RESULT);

    await expect(
      completeOAuthConformance({ sessionId: session.id, owner: "user:a" }),
    ).resolves.toEqual({ phase: "complete", result: RESULT });
  });

  it("treats another caller's session as not found", async () => {
    const session = createSession({ redirectUrl: REDIRECT, owner: "user:a" });
    setSessionResult(session.id, RESULT);

    await expect(
      completeOAuthConformance({ sessionId: session.id, owner: "guest:b" }),
    ).rejects.toBeInstanceOf(OAuthConformanceSessionNotFoundError);
    expect(
      submitOAuthConformanceCode({
        sessionId: session.id,
        code: "code",
        owner: "guest:b",
      }),
    ).toBe(false);
  });
});
