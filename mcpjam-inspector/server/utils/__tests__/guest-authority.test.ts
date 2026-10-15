import { describe, expect, it } from "vitest";
import {
  GuestAuthorityConfigError,
  resolveGuestAuthority,
} from "../guest-authority.js";

const DEV_BACKEND = "https://energized-ant-201.convex.site";

describe("resolveGuestAuthority", () => {
  it("defaults the standard OSS profile to the hosted authority, endpoints all on one origin", () => {
    const authority = resolveGuestAuthority({ CONVEX_HTTP_URL: DEV_BACKEND });
    expect(authority).toEqual({
      kind: "hosted",
      id: "hosted:https://app.mcpjam.com",
      origin: "https://app.mcpjam.com",
      sessionUrl: "https://app.mcpjam.com/api/web/guest-session",
      revokeUrl: "https://app.mcpjam.com/api/web/guest-session/revoke",
      promotionProofUrl:
        "https://app.mcpjam.com/api/web/guest-session/promotion-proof",
      // NOT `${CONVEX_HTTP_URL}/guest/jwks`: that is an unrelated backend.
      jwksUrl: "https://app.mcpjam.com/api/web/guest-jwks",
    });
  });

  it("uses the backend authority in hosted mode, with the profile's secret", () => {
    const authority = resolveGuestAuthority({
      VITE_MCPJAM_HOSTED_MODE: "true",
      CONVEX_HTTP_URL: "https://rt-http.mcpjam.com/",
      MCPJAM_GUEST_SESSION_SHARED_SECRET: "s3cret",
    });
    expect(authority.kind).toBe("backend");
    expect(authority.sessionUrl).toBe(
      "https://rt-http.mcpjam.com/guest/session",
    );
    expect(authority.revokeUrl).toBe(
      "https://rt-http.mcpjam.com/guest/session/revoke",
    );
    expect(authority.promotionProofUrl).toBe(
      "https://rt-http.mcpjam.com/guest/promotion-proof",
    );
    expect(authority.jwksUrl).toBe("https://rt-http.mcpjam.com/guest/jwks");
    expect(authority.sharedSecret).toBe("s3cret");
  });

  it("selects the backend authority when the profile carries its own secret", () => {
    const authority = resolveGuestAuthority({
      CONVEX_HTTP_URL: DEV_BACKEND,
      MCPJAM_GUEST_SESSION_SHARED_SECRET: "dev-secret",
    });
    expect(authority.kind).toBe("backend");
    expect(authority.id).toBe(`backend:${DEV_BACKEND}`);
  });

  it("refuses a backend authority without the profile's shared secret (no generated substitute)", () => {
    expect(() =>
      resolveGuestAuthority({
        MCPJAM_GUEST_AUTHORITY: "backend",
        CONVEX_HTTP_URL: DEV_BACKEND,
      }),
    ).toThrow(GuestAuthorityConfigError);
    expect(() =>
      resolveGuestAuthority({
        VITE_MCPJAM_HOSTED_MODE: "true",
        CONVEX_HTTP_URL: DEV_BACKEND,
      }),
    ).toThrow(/MCPJAM_GUEST_SESSION_SHARED_SECRET/);
  });

  it("refuses a backend authority whose JWKS override points at another backend", () => {
    expect(() =>
      resolveGuestAuthority({
        CONVEX_HTTP_URL: DEV_BACKEND,
        MCPJAM_GUEST_SESSION_SHARED_SECRET: "x",
        MCPJAM_GUEST_JWKS_URL: "https://app.mcpjam.com/api/web/guest-jwks",
      }),
    ).toThrow(/own JWKS/);
  });

  it("derives every hosted endpoint from the legacy session override's origin", () => {
    const authority = resolveGuestAuthority({
      MCPJAM_GUEST_SESSION_URL:
        "https://staging.mcpjam.com/api/web/guest-session",
    });
    expect(authority.kind).toBe("hosted");
    expect(authority.revokeUrl).toBe(
      "https://staging.mcpjam.com/api/web/guest-session/revoke",
    );
    expect(authority.jwksUrl).toBe(
      "https://staging.mcpjam.com/api/web/guest-jwks",
    );
  });

  it("rejects a hosted endpoint override from a different origin (no mixing authorities)", () => {
    expect(() =>
      resolveGuestAuthority({
        MCPJAM_GUEST_AUTHORITY: "hosted",
        MCPJAM_GUEST_AUTHORITY_ORIGIN: "https://staging.mcpjam.com",
        MCPJAM_GUEST_JWKS_URL: "https://rt-http.mcpjam.com/guest/jwks",
      }),
    ).toThrow(/does not belong to the selected guest authority/);
  });

  it("rejects an unknown authority kind", () => {
    expect(() =>
      resolveGuestAuthority({ MCPJAM_GUEST_AUTHORITY: "local" }),
    ).toThrow(/must be "backend" or "hosted"/);
  });

  it("never puts a credential in the authority id or error messages", () => {
    const authority = resolveGuestAuthority({
      CONVEX_HTTP_URL: DEV_BACKEND,
      MCPJAM_GUEST_SESSION_SHARED_SECRET: "do-not-log-me",
    });
    expect(authority.id).not.toContain("do-not-log-me");
    try {
      resolveGuestAuthority({
        MCPJAM_GUEST_SESSION_SHARED_SECRET: "do-not-log-me",
      });
      throw new Error("expected a configuration error");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("do-not-log-me");
    }
  });
});
