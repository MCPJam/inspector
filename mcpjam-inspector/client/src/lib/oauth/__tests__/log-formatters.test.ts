import { describe, expect, it } from "vitest";
import type { OAuthFlowState, OAuthFlowStep } from "@mcpjam/sdk/browser";
import { generateGuideText, generateRawText } from "../log-formatters";

describe("OAuth copy log formatters", () => {
  it("redacts credential aliases, exact token fields, and URL user-info", () => {
    const step = "token_request" as OAuthFlowStep;
    const infoLog = {
      id: "failed-token-request",
      step,
      timestamp: 1,
      level: "error",
      label: "Token request failed",
      data: {
        token: "exact-token-secret",
        token_endpoint: "https://auth.example.com/token",
        request:
          "clientSecret=camel-client-secret&accessToken=camel-access-secret&authorization=text-auth-secret&cookie=text-cookie-secret&credential=text-credential-secret&setCookie=text-set-cookie-secret",
      },
      error: {
        message: "Bearer info-error-secret",
        details: { stack: "idToken=camel-id-secret" },
      },
    } as any;
    const httpEntry = {
      step,
      timestamp: 2,
      request: {
        method: "POST",
        url: "https://url-user-secret:url-password-secret@auth.example.com/token?token=query-token-secret#fragment-secret",
        headers: { Authorization: "Bearer request-bearer-secret" },
        body: "grant_type=authorization_code&client_secret=snake-client-secret",
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        body: {
          token: "response-token-secret",
          accessToken: "response-access-secret",
          token_type: "Bearer",
        },
      },
    } as any;
    const state = {
      currentStep: step,
      infoLogs: [infoLog],
      httpHistory: [httpEntry],
    } as OAuthFlowState;

    const guide = generateGuideText(state, [
      {
        step,
        entries: [
          { type: "info", log: infoLog },
          { type: "http", entry: httpEntry },
        ],
        firstTimestamp: 1,
      },
    ]);
    const raw = generateRawText(state, [
      { type: "info", timestamp: 1, log: infoLog, key: "info" },
      { type: "http", timestamp: 2, entry: httpEntry, key: "http" },
    ]);

    for (const output of [guide, raw]) {
      for (const secret of [
        "exact-token-secret",
        "camel-client-secret",
        "camel-access-secret",
        "text-auth-secret",
        "text-cookie-secret",
        "text-credential-secret",
        "text-set-cookie-secret",
        "info-error-secret",
        "camel-id-secret",
        "url-user-secret",
        "url-password-secret",
        "query-token-secret",
        "fragment-secret",
        "request-bearer-secret",
        "snake-client-secret",
        "response-token-secret",
        "response-access-secret",
      ]) {
        expect(output).not.toContain(secret);
      }
      expect(output).toContain("[REDACTED]");
      expect(output).toContain("https://auth.example.com/token");
      expect(output).toContain('"token_type": "Bearer"');
    }

    // Copy-time redaction must not mutate the local trace shown on-screen.
    expect(infoLog.data.token).toBe("exact-token-secret");
    expect(httpEntry.request.url).toContain("url-user-secret");
  });
});
