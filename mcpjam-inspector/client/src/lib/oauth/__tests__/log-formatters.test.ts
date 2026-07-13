import { describe, expect, it } from "vitest";
import type { OAuthFlowState, OAuthFlowStep } from "@mcpjam/sdk/browser";
import { generateGuideText, generateRawText } from "../log-formatters";

describe("OAuth copy log formatters", () => {
  it("redacts credentials from Guide and Raw output without changing the live trace", () => {
    const step = "token_request" as OAuthFlowStep;
    const infoLog = {
      id: "failed-token-request",
      step,
      timestamp: 1,
      level: "error",
      label: "Token request failed",
      data: {
        token_endpoint: "https://auth.example.com/token",
        headers: { Authorization: "Bearer info-bearer-secret" },
        body: "client_secret=info-client-secret&code=info-code-secret",
      },
      error: {
        message: "Bearer info-error-secret",
        details: { stack: "id_token=info-stack-secret" },
      },
    } as any;
    const httpEntry = {
      step,
      timestamp: 2,
      request: {
        method: "POST",
        url: "https://auth.example.com/token?code=query-code-secret",
        headers: {
          authorization: "Bearer request-bearer-secret",
          Cookie: "session=request-cookie-secret",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=authorization_code&client_secret=request-client-secret&code=request-code-secret",
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "Set-Cookie": "session=response-cookie-secret" },
        body: JSON.stringify({
          access_token: "response-access-secret",
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
        "info-bearer-secret",
        "info-client-secret",
        "info-code-secret",
        "info-error-secret",
        "info-stack-secret",
        "query-code-secret",
        "request-bearer-secret",
        "request-cookie-secret",
        "request-client-secret",
        "request-code-secret",
        "response-cookie-secret",
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

    // Redaction happens only while formatting the copy; local on-screen data
    // remains untouched for debugging.
    expect(infoLog.data.headers.Authorization).toBe(
      "Bearer info-bearer-secret",
    );
    expect(httpEntry.response.body).toContain("response-access-secret");
  });
});
