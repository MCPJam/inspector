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
        basicAuthorization: "Authorization: Basic dXNlcjpwYXNzd29yZA==",
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
        "dXNlcjpwYXNzd29yZA==",
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

  it("prints split request/response halves under their own step sections", () => {
    // The logger splits a reached exchange into a request item on the request
    // step and a response item on the paired received step; the guide text
    // must mirror that placement.
    const httpEntry = {
      step: "token_request" as OAuthFlowStep,
      timestamp: 10,
      duration: 25,
      request: {
        method: "POST",
        url: "https://auth.example.com/token",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code",
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token_type: "Bearer" }),
      },
    } as any;
    const state = {
      currentStep: "received_access_token",
      infoLogs: [],
      httpHistory: [httpEntry],
    } as unknown as OAuthFlowState;

    const guide = generateGuideText(state, [
      {
        step: "token_request" as OAuthFlowStep,
        entries: [
          { type: "http", entry: httpEntry, view: "request", timestamp: 10 },
        ],
        firstTimestamp: 10,
      },
      {
        step: "received_access_token" as OAuthFlowStep,
        entries: [
          { type: "http", entry: httpEntry, view: "response", timestamp: 35 },
        ],
        firstTimestamp: 35,
      },
    ]);

    const requestHeader = guide.indexOf(
      "Request Tokens with Authorization Code"
    );
    const receivedHeader = guide.indexOf("Tokens Received");
    expect(requestHeader).toBeGreaterThan(-1);
    expect(receivedHeader).toBeGreaterThan(requestHeader);

    const requestSection = guide.slice(requestHeader, receivedHeader);
    const receivedSection = guide.slice(receivedHeader);
    expect(requestSection).toContain("Request Body:");
    expect(requestSection).toContain(
      "Response: recorded under [received_access_token]"
    );
    expect(requestSection).not.toContain("Status: 200");
    expect(requestSection).not.toContain("Response Body:");
    expect(receivedSection).toContain("Response to: POST");
    expect(receivedSection).toContain("Status: 200 OK");
    expect(receivedSection).toContain("Duration: 25ms");
    expect(receivedSection).toContain("Response Body:");
    expect(receivedSection).not.toContain("Request Body:");
  });

  it("keeps the original guide step number when copying one step", () => {
    const state = { currentStep: "token_request" } as OAuthFlowState;
    const groups = [
      {
        step: "request_without_token" as OAuthFlowStep,
        entries: [],
        firstTimestamp: 1,
      },
      {
        step: "received_401_unauthorized" as OAuthFlowStep,
        entries: [],
        firstTimestamp: 2,
      },
      {
        step: "token_request" as OAuthFlowStep,
        entries: [],
        firstTimestamp: 3,
      },
    ];

    const copied = generateGuideText(state, groups, {
      step: "token_request",
    });

    expect(copied).toContain("3. Request Tokens with Authorization Code");
    expect(copied).not.toContain("1. Request Tokens with Authorization Code");
  });

  it("prints raw request and response halves under their own steps", () => {
    const httpEntry = {
      step: "request_without_token" as OAuthFlowStep,
      timestamp: 10,
      duration: 25,
      request: {
        method: "POST",
        url: "https://mcp.example.com/mcp",
        headers: { Accept: "application/json" },
        body: { jsonrpc: "2.0" },
      },
      response: {
        status: 401,
        statusText: "Unauthorized",
        headers: { "www-authenticate": "Bearer" },
        body: { error: "unauthorized" },
      },
    } as any;
    const raw = generateRawText({} as OAuthFlowState, [
      {
        type: "http",
        timestamp: 10,
        entry: httpEntry,
        step: "request_without_token",
        view: "request",
        key: "request",
      },
      {
        type: "http",
        timestamp: 35,
        entry: httpEntry,
        step: "received_401_unauthorized",
        view: "response",
        key: "response",
      },
    ]);

    const requestSection = raw.indexOf("[request sent]");
    const responseSection = raw.lastIndexOf("[401 Unauthorized]");
    expect(requestSection).toBeGreaterThan(-1);
    expect(responseSection).toBeGreaterThan(requestSection);
    const requestText = raw.slice(requestSection, responseSection);
    const responseText = raw.slice(responseSection);
    expect(raw).toContain("request_without_token");
    expect(raw).toContain("received_401_unauthorized");
    expect(requestText).toContain("Request Body:");
    expect(requestText).toContain(
      "Response: recorded under [received_401_unauthorized]"
    );
    expect(requestText).not.toContain("Response Headers:");
    expect(responseText).toContain("[401 Unauthorized]");
    expect(responseText).toContain("Response to: POST");
    expect(responseText).toContain("Response Headers:");
    expect(responseText).not.toContain("Request Body:");
  });
});
