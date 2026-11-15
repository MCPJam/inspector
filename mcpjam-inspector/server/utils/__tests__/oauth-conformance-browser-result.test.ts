import { describe, expect, it } from "vitest";
import type { ConformanceResult } from "@mcpjam/sdk";
import { toBrowserOAuthResult } from "../oauth-conformance-browser-result.js";

const SECRET = "prereg-secret-value";
const ACCESS_TOKEN = "access-token-value";
const REFRESH_TOKEN = "refresh-token-value";
const BASIC = `Basic ${btoa(`prereg-client:${SECRET}`)}`;

function rawResult(): ConformanceResult {
  const tokenAttempt = {
    step: "token_request",
    timestamp: 1,
    duration: 12,
    request: {
      method: "POST",
      url: "https://auth.example/token",
      headers: { Authorization: BASIC },
      body: { grant_type: "authorization_code", code: "auth-code" },
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      body: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN },
    },
  };
  return {
    passed: true,
    outcome: "passed",
    protocolVersion: "2025-11-25",
    registrationStrategy: "preregistered",
    serverUrl: "https://mcp.example/mcp",
    summary: "OAuth conformance passed",
    durationMs: 20,
    credentials: {
      clientId: "prereg-client",
      clientSecret: SECRET,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    },
    steps: [
      {
        step: "token_request",
        title: "Request Tokens with Authorization Code",
        summary: "Exchange the code for a token.",
        status: "passed",
        durationMs: 12,
        logs: [
          {
            id: "oauth-tokens",
            level: "info",
            step: "token_request",
            label: "OAuth Tokens",
            data: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN },
            timestamp: 1,
          },
        ],
        http: tokenAttempt,
        httpAttempts: [tokenAttempt],
      },
    ],
  } as unknown as ConformanceResult;
}

describe("toBrowserOAuthResult", () => {
  it("sends no client secret, tokens or Authorization header", () => {
    const json = JSON.stringify(toBrowserOAuthResult(rawResult()));
    for (const secret of [SECRET, ACCESS_TOKEN, REFRESH_TOKEN, BASIC]) {
      expect(json).not.toContain(secret);
    }
    expect(json).not.toContain("credentials");
  });

  it("keeps each request's method, URL and status for the step rows", () => {
    const [step] = toBrowserOAuthResult(rawResult()).steps;
    expect(step.title).toBe("Request Tokens with Authorization Code");
    expect(step.status).toBe("passed");
    expect(step.logs).toEqual([]);
    expect(step.httpAttempts).toHaveLength(1);
    expect(step.httpAttempts[0]).toMatchObject({
      request: { method: "POST", url: "https://auth.example/token" },
      response: { status: 200, statusText: "OK" },
    });
    expect(step.http).toBe(step.httpAttempts[0]);
  });

  it("removes secret query parameters from request URLs", () => {
    const result = rawResult();
    result.steps[0]!.httpAttempts[0]!.request.url =
      "https://auth.example/token?client_secret=leak";
    const json = JSON.stringify(toBrowserOAuthResult(result));
    expect(json).not.toContain("leak");
  });
});
