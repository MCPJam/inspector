import { describe, expect, it } from "vitest";
import { getXAAErrorGuidance, latestErroredHttpEntry } from "../error-guidance";
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

// The `/proxy/token` endpoint always returns HTTP 200 and wraps the upstream
// authorization-server response as { status, body }. Tests for jwt_bearer_request
// must preserve this shape; otherwise the outer-status path masks bugs where
// we fail to inspect the nested status.
function proxyResponse(upstreamStatus: number, upstreamBody: unknown) {
  return httpEntry({
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      body: { status: upstreamStatus, body: upstreamBody },
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

    it("does not misclassify unrelated errors that mention 'resource' as invalid_target", () => {
      // With an httpEntry present, we fall through to the generic AS-failure
      // card — but we must not pick the invalid_target branch just because
      // the state error string contains the word "resource".
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        stateError: "Failed to allocate resource pool",
        httpEntry: proxyResponse(500, {}),
      });
      expect(guidance?.title).toBe(
        "JWT bearer request failed at the authorization server",
      );
    });

    it("matches invalid_target via explicit upstream error code", () => {
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        httpEntry: proxyResponse(400, { error: "invalid_target" }),
      });
      expect(guidance?.title).toBe(
        "Authorization server rejected the `resource` claim",
      );
    });

    it("does not hijack AS errors whose description coincidentally contains 'token endpoint'", () => {
      // Defensive: an AS error_description like "The token endpoint is not
      // authorized for this grant type" used to match the pre-validation
      // check and show the misleading "ID-JAG or token endpoint missing"
      // card instead of the correct AS-specific guidance.
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        stateError:
          "The token endpoint is not authorized for this grant type Does the authorization server trust the synthetic issuer JWKS and support `urn:ietf:params:oauth:grant-type:jwt-bearer`?",
        httpEntry: proxyResponse(400, { error: "unsupported_grant_type" }),
      });
      expect(guidance?.title).toContain("doesn't support the jwt-bearer grant");
    });

    it("handles pre-request validation errors (no httpEntry) as a Reset prompt, not an AS failure", () => {
      // When the state machine short-circuits because idJag or tokenEndpoint
      // is missing, no HTTP request was made. Showing "JWT bearer request
      // failed at the authorization server" with a Register-issuer action
      // would be factually wrong (and hide the real validation message).
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        stateError:
          "The flow is missing an ID-JAG or token endpoint. Finish discovery and token exchange first.",
      });
      expect(guidance?.title).toBe("ID-JAG or token endpoint missing");
      expect(guidance?.actions.map((a) => a.intent)).toContain("reset");
    });

    it("does not produce a generic jwt_bearer card when there is no HTTP attempt at all", () => {
      // Defensive: any bare stateError for this step without an httpEntry or
      // failed response should fall through so the raw alert shows the real
      // message, rather than the misleading AS-side fallback card.
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        stateError: "Something else went wrong before we called the AS.",
      });
      expect(guidance).toBeNull();
    });

    it("treats a malformed proxy wrapper (outer 200, missing nested status) as a failure", () => {
      // State machine's requestAccessToken does:
      //   if (!upstreamStatus || upstreamStatus < 200 || upstreamStatus >= 300)
      // so a response lacking a numeric nested status is a failure. Previously
      // latestErroredHttpEntry / getXAAErrorGuidance didn't detect this and
      // the user saw a raw error alert instead of a structured card.
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        stateError: "Authorization server returned an unknown status.",
        httpEntry: httpEntry({
          step: "jwt_bearer_request",
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { body: { something: "else" } },
          },
        }),
      });
      expect(guidance?.title).toBe(
        "JWT bearer request failed at the authorization server",
      );
    });

    it("produces a guidance card for a proxy-wrapped upstream failure even without an OAuth error field", () => {
      // Outer 200, nested 500, empty body. Previously latestErroredHttpEntry
      // flagged it, but getXAAErrorGuidance only looked at the outer status
      // and returned null — so the user saw nothing.
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        httpEntry: proxyResponse(500, {}),
      });
      expect(guidance?.title).toBe(
        "JWT bearer request failed at the authorization server",
      );
    });

    it("does not treat a non-jwt_bearer step with a status-shaped body as a proxy wrapper", () => {
      // Another step's body might coincidentally have a `status` field.
      // We should not interpret that as a failed upstream proxy call.
      const guidance = getXAAErrorGuidance({
        step: "user_authentication",
        httpEntry: httpEntry({
          step: "user_authentication",
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { status: 500, user: "alice" },
          },
        }),
      });
      expect(guidance).toBeNull();
    });

    it("extracts the OAuth error code even when error_description is also present", () => {
      // When the AS returns both `error` and `error_description`, the state
      // machine's extractErrorMessage prefers the description, so stateError
      // won't contain the raw code. We must still surface specific guidance
      // by reading the `error` field out of the proxy-wrapped body.
      const guidance = getXAAErrorGuidance({
        step: "jwt_bearer_request",
        stateError:
          "Grant type is not supported for this client Does the authorization server trust the synthetic issuer JWKS and support `urn:ietf:params:oauth:grant-type:jwt-bearer`?",
        httpEntry: proxyResponse(400, {
          error: "unsupported_grant_type",
          error_description: "Grant type is not supported for this client",
        }),
      });
      expect(guidance?.title).toContain("doesn't support the jwt-bearer grant");
    });
  });

  describe("defensive scoping", () => {
    it("does not produce a card when a non-jwt_bearer entry coincidentally has a nested body.error field", () => {
      // A discover_resource_metadata 200 response whose body happens to be
      // shaped like { body: { error: "..." } }. Previously the extractor
      // unwrapped body.body regardless of step and surfaced the nested
      // error, which could drive false "RFC 9728 metadata" guidance.
      const guidance = getXAAErrorGuidance({
        step: "discover_resource_metadata",
        httpEntry: httpEntry({
          step: "discover_resource_metadata",
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { body: { error: "spooky" } },
          },
        }),
      });
      expect(guidance).toBeNull();
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

    it("explains authorization server discovery failure when a request was actually attempted", () => {
      const guidance = getXAAErrorGuidance({
        step: "discover_authz_metadata",
        stateError: "Authorization server metadata discovery failed.",
        httpEntry: httpEntry({
          step: "discover_authz_metadata",
          response: {
            status: 404,
            statusText: "Not Found",
            headers: {},
            body: {},
          },
        }),
      });
      expect(guidance?.title).toBe("Authorization server discovery failed");
    });

    it("does not show 'discovery failed' for a successful 2xx response paired with a parse stateError", () => {
      // E.g. the AS returned 200 but the metadata parsed ok then failed a
      // post-parse check ("did not include a token_endpoint"). The HTTP
      // request itself succeeded, so the "Neither well-known returned a
      // valid response" message would be misleading — let the raw Alert
      // show the specific post-parse error instead.
      const guidance = getXAAErrorGuidance({
        step: "discover_authz_metadata",
        stateError: "Authorization metadata did not include a token_endpoint.",
        httpEntry: httpEntry({
          step: "discover_authz_metadata",
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { issuer: "https://as.example.com" },
          },
        }),
      });
      expect(guidance).toBeNull();
    });

    it("routes the 'issuer is missing' pre-validation error to a specific Configure card, not 'discovery failed'", () => {
      // The state machine short-circuits before any request when no issuer
      // is configured. Showing "Neither well-known returned a valid
      // response at the configured issuer" would be factually wrong.
      const guidance = getXAAErrorGuidance({
        step: "discover_authz_metadata",
        stateError:
          "Authorization Server issuer is missing. Configure it manually or retry resource metadata discovery.",
      });
      expect(guidance?.title).toBe(
        "Authorization server issuer not configured",
      );
      expect(guidance?.actions.map((a) => a.intent)).toContain("configure");
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

    it("flags 401 responses even when a stateError is also set (bug #3 regression)", () => {
      const guidance = getXAAErrorGuidance({
        step: "authenticated_mcp_request",
        stateError: "Authenticated MCP request failed with 401",
        httpEntry: httpEntry({
          step: "authenticated_mcp_request",
          response: { status: 401, statusText: "", headers: {}, body: {} },
        }),
      });
      expect(guidance?.title).toContain("rejected the access token");
    });

    it("surfaces a catch-all card for non-401/403 failures (e.g. 500)", () => {
      const guidance = getXAAErrorGuidance({
        step: "authenticated_mcp_request",
        httpEntry: httpEntry({
          step: "authenticated_mcp_request",
          response: {
            status: 500,
            statusText: "Internal Server Error",
            headers: {},
            body: {},
          },
        }),
      });
      expect(guidance?.title).toBe("MCP server request failed");
      expect(guidance?.explanation).toContain("500");
      expect(guidance?.severity).toBe("error");
    });

    it("surfaces a network-error variant of the catch-all", () => {
      const guidance = getXAAErrorGuidance({
        step: "authenticated_mcp_request",
        httpEntry: httpEntry({
          step: "authenticated_mcp_request",
          error: { message: "fetch failed" },
        }),
      });
      expect(guidance?.title).toBe("MCP server request failed");
      expect(guidance?.explanation).toContain("network error");
    });
  });

  describe("generic HTTP failure fallback", () => {
    it("surfaces a warning card for a non-2xx response even when no step-specific case matches", () => {
      // user_authentication 500 isn't specifically handled; the generic
      // fallback should still produce a callout so the user isn't left
      // staring at silence.
      const guidance = getXAAErrorGuidance({
        step: "user_authentication",
        httpEntry: httpEntry({
          step: "user_authentication",
          response: {
            status: 500,
            statusText: "Internal Server Error",
            headers: {},
            body: {},
          },
        }),
      });
      expect(guidance?.title).toBe("Request failed");
      expect(guidance?.explanation).toContain("500");
    });
  });
});

describe("latestErroredHttpEntry", () => {
  const okEntry: XAAHttpHistoryEntry = {
    step: "discover_authz_metadata",
    timestamp: 1,
    request: { method: "GET", url: "/a", headers: {} },
    response: { status: 200, statusText: "OK", headers: {}, body: {} },
  };
  const notFoundEntry: XAAHttpHistoryEntry = {
    step: "discover_authz_metadata",
    timestamp: 0,
    request: { method: "GET", url: "/b", headers: {} },
    response: { status: 404, statusText: "Not Found", headers: {}, body: {} },
  };
  const networkErrorEntry: XAAHttpHistoryEntry = {
    step: "jwt_bearer_request",
    timestamp: 0,
    request: { method: "POST", url: "/proxy/token", headers: {} },
    error: { message: "network error" },
  };

  it("returns undefined for an empty list", () => {
    expect(latestErroredHttpEntry([])).toBeUndefined();
  });

  it("returns undefined when the final entry succeeded even if earlier ones failed (bug #2 regression)", () => {
    expect(latestErroredHttpEntry([notFoundEntry, okEntry])).toBeUndefined();
  });

  it("returns the final entry when it represents a failure", () => {
    expect(latestErroredHttpEntry([okEntry, notFoundEntry])).toBe(
      notFoundEntry,
    );
  });

  it("returns the final entry when it is a network error", () => {
    expect(latestErroredHttpEntry([okEntry, networkErrorEntry])).toBe(
      networkErrorEntry,
    );
  });

  it("detects upstream failure in a proxy-wrapped 200 response (jwt_bearer_request)", () => {
    // /proxy/token returns outer HTTP 200 but nests the upstream AS status.
    // We must inspect that nested status, otherwise the wrapped failure is
    // invisible to error-guidance.
    const proxyWrappedFailure: XAAHttpHistoryEntry = {
      step: "jwt_bearer_request",
      timestamp: 0,
      request: { method: "POST", url: "/proxy/token", headers: {} },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        body: {
          status: 400,
          body: {
            error: "unsupported_grant_type",
            error_description: "Grant type not allowed.",
          },
        },
      },
    };
    expect(latestErroredHttpEntry([proxyWrappedFailure])).toBe(
      proxyWrappedFailure,
    );
  });

  it("ignores a proxy-wrapped 200 response when the nested upstream status is a success", () => {
    const proxyWrappedSuccess: XAAHttpHistoryEntry = {
      step: "jwt_bearer_request",
      timestamp: 0,
      request: { method: "POST", url: "/proxy/token", headers: {} },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        body: {
          status: 200,
          body: { access_token: "abc", token_type: "Bearer" },
        },
      },
    };
    expect(latestErroredHttpEntry([proxyWrappedSuccess])).toBeUndefined();
  });

  it("flags a jwt_bearer proxy response without a numeric nested status (malformed wrapper)", () => {
    const malformed: XAAHttpHistoryEntry = {
      step: "jwt_bearer_request",
      timestamp: 0,
      request: { method: "POST", url: "/proxy/token", headers: {} },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        body: { body: { something: "else" } },
      },
    };
    expect(latestErroredHttpEntry([malformed])).toBe(malformed);
  });

  it("only inspects nested upstream status for jwt_bearer_request entries", () => {
    // Another step's body might coincidentally have a numeric `status` field
    // that doesn't represent HTTP — we shouldn't misread that as a failure.
    const nonBearerEntry: XAAHttpHistoryEntry = {
      step: "user_authentication",
      timestamp: 0,
      request: { method: "POST", url: "/authenticate", headers: {} },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        body: { status: 500, user: "alice" },
      },
    };
    expect(latestErroredHttpEntry([nonBearerEntry])).toBeUndefined();
  });
});
