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
        headers: { Authorization: "Bearer info-bearer-secret" },
        body: "client_secret=info-client-secret&code=info-code-secret",
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
        headers: {
          Authorization: "Bearer request-bearer-secret",
          Cookie: "session=request-cookie-secret",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=authorization_code&client_secret=snake-client-secret&code=request-code-secret",
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "Set-Cookie": "session=response-cookie-secret" },
        body: JSON.stringify({
          token: "response-token-secret",
          accessToken: "response-access-secret",
          refresh_token: "response-refresh-secret",
          token_type: "Bearer",
        }),
      },
      error: {
        message: "access_token=http-error-secret",
        details: { stack: "Bearer http-stack-secret" },
      },
    } as any;
    const state = {
      currentStep: step,
      error: "client_secret=state-client-secret",
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
        "info-bearer-secret",
        "info-client-secret",
        "info-code-secret",
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
        "request-cookie-secret",
        "snake-client-secret",
        "request-code-secret",
        "response-cookie-secret",
        "response-token-secret",
        "response-access-secret",
        "response-refresh-secret",
        "http-error-secret",
        "http-stack-secret",
        "state-client-secret",
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
    expect(httpEntry.response.body).toContain("response-access-secret");
  });
});
