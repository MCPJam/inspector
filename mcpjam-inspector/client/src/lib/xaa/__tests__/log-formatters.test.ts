import { describe, expect, it } from "vitest";
import { generateXAAFlowText } from "../log-formatters";
import { createInitialXAAFlowState } from "../types";

describe("generateXAAFlowText", () => {
  it("redacts credentials from copied request and response data", () => {
    const copied = generateXAAFlowText(
      createInitialXAAFlowState({
        currentStep: "received_access_token",
        httpHistory: [
          {
            step: "jwt_bearer_request",
            timestamp: 1,
            request: {
              method: "POST",
              url: "https://auth.example.com/token?access_token=query-secret",
              headers: {
                Authorization: "Bearer request-bearer-secret",
                COOKIE: "session=request-cookie-secret",
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: {
                client_secret: "client-secret-value",
                assertion: "id-jag-assertion-value",
                nested: { id_token: "id-token-value" },
                scope: "mcp.access",
              },
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: {
                "Set-Cookie": "session=response-cookie-secret",
                authorization: "Bearer response-bearer-secret",
              },
              body: JSON.stringify({
                access_token: "access-token-value",
                refresh_token: "refresh-token-value",
                token_type: "Bearer",
              }),
            },
          },
        ],
      }),
      { serverUrl: "https://mcp.example.com" }
    );

    for (const secret of [
      "query-secret",
      "request-bearer-secret",
      "request-cookie-secret",
      "client-secret-value",
      "id-jag-assertion-value",
      "id-token-value",
      "response-cookie-secret",
      "response-bearer-secret",
      "access-token-value",
      "refresh-token-value",
    ]) {
      expect(copied).not.toContain(secret);
    }
    expect(copied).toContain("[REDACTED]");
    expect(copied).toContain('"scope": "mcp.access"');
    expect(copied).toContain('"token_type": "Bearer"');
  });

  it("redacts sensitive fields in form-encoded bodies", () => {
    const copied = generateXAAFlowText(
      createInitialXAAFlowState({
        currentStep: "token_exchange_request",
        httpHistory: [
          {
            step: "token_exchange_request",
            timestamp: 1,
            request: {
              method: "POST",
              url: "https://idp.example.com/token",
              headers: {},
              body: "grant_type=token-exchange&subject_token=form-id-token&client_secret=form-client-secret",
            },
          },
        ],
      }),
      {}
    );

    expect(copied).not.toContain("form-id-token");
    expect(copied).not.toContain("form-client-secret");
    expect(copied).toContain("grant_type=token-exchange");
  });

  it("redacts URL credentials, fragments, Basic auth, and generic secrets", () => {
    const copied = generateXAAFlowText(
      createInitialXAAFlowState({
        currentStep: "token_exchange_request",
        httpHistory: [
          {
            step: "token_exchange_request",
            timestamp: 1,
            request: {
              method: "POST",
              url: "https://alice:url-password@example.com/token?api_key=query-api-key#fragment-secret",
              headers: {
                Authorization: "Basic basic-secret",
              },
              body: "password=form-password&api_key=form-api-key&scope=read",
            },
          },
        ],
      }),
      {
        serverUrl:
          "https://summary-user:summary-password@example.com/mcp#summary-fragment",
      }
    );

    for (const secret of [
      "alice",
      "url-password",
      "query-api-key",
      "fragment-secret",
      "basic-secret",
      "form-password",
      "form-api-key",
      "summary-user",
      "summary-password",
      "summary-fragment",
    ]) {
      expect(copied).not.toContain(secret);
    }
    expect(copied).toContain("[REDACTED]");
    expect(copied).toContain("scope=read");
  });

  it("prints the request under the request step and the response under the received step once reached", () => {
    const copied = generateXAAFlowText(
      createInitialXAAFlowState({
        currentStep: "received_access_token",
        httpHistory: [
          {
            step: "jwt_bearer_request",
            timestamp: 1,
            duration: 40,
            request: {
              method: "POST",
              url: "https://auth.example.com/token",
              headers: { "Content-Type": "application/json" },
              body: { scope: "mcp.access" },
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              body: { token_type: "Bearer" },
            },
          },
        ],
      }),
      {}
    );

    const requestHeader = copied.indexOf("[jwt_bearer_request]");
    // lastIndexOf: the request section's pointer line also names the received
    // step; the section HEADER is the later occurrence.
    const receivedHeader = copied.lastIndexOf("[received_access_token]");
    expect(requestHeader).toBeGreaterThan(-1);
    expect(receivedHeader).toBeGreaterThan(requestHeader);

    const requestSection = copied.slice(requestHeader, receivedHeader);
    const receivedSection = copied.slice(receivedHeader);
    // Request half: request fields + a pointer, no status/response fields.
    expect(requestSection).toContain("Request Body:");
    expect(requestSection).toContain(
      "Response: recorded under [received_access_token]"
    );
    expect(requestSection).not.toContain("Status: 200");
    expect(requestSection).not.toContain("Response Body:");
    // Received half: status/duration/response fields, no request fields.
    expect(receivedSection).toContain("Response to: POST");
    expect(receivedSection).toContain("Status: 200 OK");
    expect(receivedSection).toContain("Duration: 40ms");
    expect(receivedSection).toContain("Response Body:");
    expect(receivedSection).not.toContain("Request Body:");
  });

  it("hides a completed response until the received step is reached", () => {
    const copied = generateXAAFlowText(
      createInitialXAAFlowState({
        currentStep: "jwt_bearer_request",
        httpHistory: [
          {
            step: "jwt_bearer_request",
            timestamp: 1,
            request: {
              method: "POST",
              url: "https://auth.example.com/token",
              headers: {},
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: {},
              body: { token_type: "Bearer" },
            },
          },
        ],
      }),
      {}
    );

    // The SDK already has the response, but the raw view follows Continue:
    // only the request is visible until the received step is reached.
    expect(copied).not.toContain("Status: 200 OK");
    expect(copied).not.toContain("Response Body:");
    expect(copied).toContain(
      "Response: recorded under [received_access_token]"
    );
  });

  it("redacts failed requests duplicated into info logs and error text", () => {
    const copied = generateXAAFlowText(
      createInitialXAAFlowState({
        currentStep: "jwt_bearer_request",
        error: "Request failed with access_token=state-error-secret",
        infoLogs: [
          {
            id: "failed-request",
            step: "jwt_bearer_request",
            label: "Request failed",
            timestamp: 1,
            level: "error",
            data: {
              method: "POST",
              headers: { Authorization: "Bearer info-log-bearer-secret" },
              body: { assertion: "info-log-assertion-secret" },
            },
            error: {
              message: "Bearer info-log-error-secret",
              details: {
                stack: "request failed: id_token=info-log-stack-secret",
              },
            },
          },
        ],
      }),
      {}
    );

    for (const secret of [
      "state-error-secret",
      "info-log-bearer-secret",
      "info-log-assertion-secret",
      "info-log-error-secret",
      "info-log-stack-secret",
    ]) {
      expect(copied).not.toContain(secret);
    }
    expect(copied).toContain("[REDACTED]");
    expect(copied).toContain('"method": "POST"');
  });
});
