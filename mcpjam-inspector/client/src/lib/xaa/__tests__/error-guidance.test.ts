import { describe, expect, it } from "vitest";
import { getXAAErrorGuidance } from "../error-guidance";
import type { XAAHttpHistoryEntry } from "../types";

function httpEntry(
  overrides: Partial<XAAHttpHistoryEntry> = {},
): XAAHttpHistoryEntry {
  return {
    step: "jwt_bearer_request",
    timestamp: 0,
    request: {
      method: "POST",
      url: "/proxy/token",
      headers: {},
    },
    ...overrides,
  };
}

function proxyResponse(status: number, upstreamBody: unknown) {
  return httpEntry({
    response: {
      status,
      statusText: "",
      headers: {},
      body: { status, body: upstreamBody },
    },
  });
}

describe("getXAAErrorGuidance", () => {
  it("returns null when there is no error signal", () => {
    expect(
      getXAAErrorGuidance({ step: "idle" }),
    ).toBeNull();
  });

  describe("token_exchange_request", () => {
    it("flags missing client_id with a Configure action", () => {
      const guidance = getXAAErrorGuidance({
        step: "token_exchange_request",
        stateError: "Client ID is required for the ID-JAG `client_id` claim.",
      });
      expect(guidance?.title).toBe("Client ID required");
      expect(guidance?.severity).toBe("error");
      expect(guidance?.actions.map((a) => a.intent)).toContain("configure");
    });

    it("flags missing identity assertion with a Reset action", () => {
      const guidance = getXAAErrorGuidance({
        step: "token_exchange_request",
        stateError: "No identity assertion is available. Complete mock authentication first.",
      });
      expect(guidance?.title).toBe("Identity assertion missing");
      expect(guidance?.actions.map((a) => a.intent)).toContain("reset");
    });

    it("flags missing authorization server issuer", () => {
      const guidance = getXAAErrorGuidance({
        step: "token_exchange_request",
        stateError: "No authorization server issuer is available for the ID-JAG audience.",
      });
      expect(guidance?.title).toBe("Authorization server issuer missing");
      expect(guidance?.actions.map((a) => a.intent)).toContain("configure");
    });
  });

  describe("jwt_bearer_request", () => {
    it("identifies unsupported_grant_type via upstream body", () => {
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        httpEntry: proxyResponse(400, { error: "unsupported_grant_type" }),
      });
      expect(guidance?.title).toContain("doesn't support the jwt-bearer grant");
      expect(guidance?.severity).toBe("error");
    });

    it("identifies invalid_client via upstream body", () => {
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        httpEntry: proxyResponse(401, { error: "invalid_client" }),
      });
      expect(guidance?.title).toContain("doesn't recognize the client");
    });

    it("identifies invalid_grant via upstream body", () => {
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        httpEntry: proxyResponse(400, { error: "invalid_grant" }),
      });
      expect(guidance?.title).toContain("rejected the ID-JAG assertion");
      expect(guidance?.actions.map((a) => a.intent)).toContain("bootstrap");
    });

    it("falls back to a generic JWT-bearer failure card when the error code is unknown", () => {
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        httpEntry: proxyResponse(500, { error: "server_error" }),
      });
      expect(guidance?.title).toBe(
        "JWT bearer request failed at the authorization server",
      );
    });

    it("matches state-error strings when upstream body is missing", () => {
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        stateError: "Authorization server returned unsupported_grant_type.",
      });
      expect(guidance?.title).toContain("doesn't support the jwt-bearer grant");
    });
  });

  describe("discovery steps", () => {
    it("explains missing RFC 9728 metadata", () => {
      const guidance = getXAAErrorGuidance({
        step: "discover_resource_metadata",
        stateError: "Resource metadata request failed with 404",
      });
      expect(guidance?.title).toContain("RFC 9728 metadata");
    });

    it("explains authorization server discovery failure", () => {
      const guidance = getXAAErrorGuidance({
        step: "discover_authz_metadata",
        stateError: "Authorization server metadata discovery failed.",
      });
      expect(guidance?.title).toBe("Authorization server discovery failed");
    });
  });

  describe("authenticated_mcp_request", () => {
    it("flags 401 responses as token rejection", () => {
      const guidance = getXAAErrorGuidance({
        step: "authenticated_mcp_request",
        httpEntry: httpEntry({
          step: "authenticated_mcp_request",
          response: { status: 401, statusText: "", headers: {}, body: {} },
        }),
      });
      expect(guidance?.title).toContain("rejected the access token");
    });
  });
});
