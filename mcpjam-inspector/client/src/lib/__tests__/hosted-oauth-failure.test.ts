import { describe, expect, it } from "vitest";
import { describeHostedOAuthFailure } from "@/lib/hosted-oauth-failure";

// Messages below are copied from real CONVEX-PY events rather than invented,
// so the parser is pinned to what the backend actually throws.
const UNREACHABLE =
  "Uncaught Error: HTTP 530 trying to load OAuth metadata from https://eliya.descope.team/.well-known/oauth-authorization-server/v1/apps/agentic/P3HPHwb4OyQsnBBe0qSh1lzd0beM/MS3HPHzvY6sFscOfZ416p9ZWLDTLa (error code: 1033)";

const DECLINED = "Uncaught InvalidGrantError: Token is not active";

const DECLINED_WITH_BODY =
  'Uncaught ServerError: HTTP 400: Invalid OAuth error response: [{"expected":"string"}]. Raw body: {"code":400,"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}';

describe("describeHostedOAuthFailure", () => {
  it("names the host and shows the status the host returned", () => {
    const copy = describeHostedOAuthFailure(UNREACHABLE, "Descope");

    expect(copy).toEqual({
      kind: "unreachable",
      title: "Could not reach eliya.descope.team",
      detail: [
        "GET https://eliya.descope.team/.well-known/oauth-authorization-server/v1/apps/agentic/P3HPHwb4OyQsnBBe0qSh1lzd0beM/MS3HPHzvY6sFscOfZ416p9ZWLDTLa",
        "HTTP 530, error code: 1033",
      ],
      action: "retry",
    });
  });

  it("omits the body clause when the backend captured no body", () => {
    const copy = describeHostedOAuthFailure(
      "HTTP 502 trying to load OAuth metadata from https://tal.descope.team/.well-known/oauth-authorization-server",
      "Descope"
    );

    expect(copy?.detail[1]).toBe("HTTP 502");
  });

  it("asks for a reconnect when the provider rejected the refresh token", () => {
    const copy = describeHostedOAuthFailure(DECLINED, "Linear");

    expect(copy?.kind).toBe("declined");
    expect(copy?.title).toBe("Refresh token declined for Linear");
    expect(copy?.action).toBe("reconnect");
  });

  it("shows the provider's own body rather than the schema noise wrapping it", () => {
    const copy = describeHostedOAuthFailure(DECLINED_WITH_BODY, "Supabase");

    expect(copy?.kind).toBe("declined");
    expect(copy?.detail).toEqual([
      '{"code":400,"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}',
    ]);
  });

  it("never pairs a host with a message that host did not return", () => {
    // An unreachable host cannot also have answered "Token is not active" —
    // whichever branch matches must carry only its own event's values.
    const copy = describeHostedOAuthFailure(UNREACHABLE, "Descope");

    expect(copy?.kind).toBe("unreachable");
    expect(copy?.detail.join(" ")).not.toMatch(/not active/i);
  });

  it("returns null when the error is not an OAuth refresh failure", () => {
    expect(describeHostedOAuthFailure("Something else broke", "X")).toBeNull();
    expect(describeHostedOAuthFailure("", "X")).toBeNull();
    expect(describeHostedOAuthFailure(null, "X")).toBeNull();
  });
});

// Structured shapes: what actually reaches the client once the backend
// classifies the failure (backend #922/#927). The WebApiError carries `code`
// and `details` off the JSON error body; the messages here are the real ones
// the backend sends, not invented.
describe("describeHostedOAuthFailure structured backend shapes", () => {
  const UNREACHABLE_503 = Object.assign(
    new Error("Could not reach the authorization server (HTTP 502)."),
    {
      code: "authorization_server_unreachable",
      details: {
        authorizationServerUnreachable: true,
        serverId: "srv_1",
        serverName: "Descope",
        failure: {
          url: "https://eliya.descope.team/oauth2/v1/apps/token",
          status: 502,
          body: '{"title":"Error 502: Bad gateway","retryable":true}',
        },
      },
    }
  );

  it("names the host from the recorded failure and offers Retry", () => {
    const copy = describeHostedOAuthFailure(UNREACHABLE_503, "Descope");

    expect(copy).toEqual({
      kind: "unreachable",
      title: "Could not reach eliya.descope.team",
      detail: [
        "https://eliya.descope.team/oauth2/v1/apps/token",
        'HTTP 502, {"title":"Error 502: Bad gateway","retryable":true}',
      ],
      action: "retry",
    });
  });

  it("falls back to the backend message when no failure was recorded", () => {
    const copy = describeHostedOAuthFailure(
      Object.assign(new Error("Could not reach the authorization server."), {
        code: "authorization_server_unreachable",
        details: { authorizationServerUnreachable: true, failure: null },
      }),
      "Descope"
    );

    expect(copy).toEqual({
      kind: "unreachable",
      title: "Could not reach the authorization server",
      detail: ["Could not reach the authorization server."],
      action: "retry",
    });
  });

  it("classifies the backend's generic 401 as a decline needing Reconnect", () => {
    // The inspector server remaps refresh_token_invalid to UNAUTHORIZED but
    // keeps details.refreshTokenInvalid; the message matches no provider
    // regex, so only the structured branch can catch it.
    const copy = describeHostedOAuthFailure(
      Object.assign(
        new Error("Hosted OAuth refresh token is invalid. Please reconnect."),
        {
          code: "UNAUTHORIZED",
          details: {
            oauthRequired: true,
            refreshTokenInvalid: true,
            serverId: "srv_1",
            serverName: "Linear",
          },
        }
      ),
      "Linear"
    );

    expect(copy?.kind).toBe("declined");
    expect(copy?.action).toBe("reconnect");
    expect(copy?.detail).toEqual([
      "Hosted OAuth refresh token is invalid. Please reconnect.",
    ]);
  });
});

describe("describeHostedOAuthFailure invalid_client messages", () => {
  // Real CONVEX-PY events: paths that still surface the raw provider message
  // (older backend, uncaught throws) rather than the structured 401.
  it.each([
    "Uncaught InvalidClientError: Unknown client. The authorization flow may have expired — please retry.",
    "Uncaught InvalidClientError: Invalid client_id",
    "Uncaught InvalidClientError: Client authentication failed (e.g., unknown client, no client authentication included, or unsupported authentication method).",
  ])("asks for a reconnect: %s", (message) => {
    const copy = describeHostedOAuthFailure(message, "Notion");

    expect(copy?.kind).toBe("declined");
    expect(copy?.title).toBe("Refresh token declined for Notion");
    expect(copy?.action).toBe("reconnect");
  });
});
