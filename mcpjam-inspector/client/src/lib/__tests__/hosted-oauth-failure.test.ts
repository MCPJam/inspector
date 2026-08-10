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
