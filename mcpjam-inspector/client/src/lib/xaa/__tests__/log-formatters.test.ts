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
      { serverUrl: "https://mcp.example.com" },
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
      {},
    );

    expect(copied).not.toContain("form-id-token");
    expect(copied).not.toContain("form-client-secret");
    expect(copied).toContain("grant_type=token-exchange");
  });
});
