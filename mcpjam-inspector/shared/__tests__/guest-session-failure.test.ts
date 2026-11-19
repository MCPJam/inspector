/**
 * The guest-session failure details cross into a browser-visible 503 body, so
 * this sanitizer is what keeps anything but closed values off the wire.
 */
import { describe, expect, it } from "vitest";
import {
  GUEST_SESSION_FAILURE_CODES,
  GUEST_SESSION_FAILURE_REASONS,
  guestSessionFailureCode,
  sanitizeGuestSessionFailureDetails,
} from "../guest-session-failure";

describe("sanitizeGuestSessionFailureDetails", () => {
  it("passes a valid object through", () => {
    expect(
      sanitizeGuestSessionFailureDetails({
        reason: "upstream_status",
        upstreamStatus: 522,
      }),
    ).toEqual({ reason: "upstream_status", upstreamStatus: 522 });
    expect(
      sanitizeGuestSessionFailureDetails({
        reason: "network",
        networkCode: "ENOTFOUND",
      }),
    ).toEqual({ reason: "network", networkCode: "ENOTFOUND" });
  });

  it("returns undefined without a known reason", () => {
    expect(sanitizeGuestSessionFailureDetails({ reason: "boom" })).toBe(
      undefined,
    );
    expect(sanitizeGuestSessionFailureDetails({})).toBe(undefined);
    expect(sanitizeGuestSessionFailureDetails(null)).toBe(undefined);
    expect(sanitizeGuestSessionFailureDetails("timeout")).toBe(undefined);
  });

  it("drops an out-of-range or fractional upstream status", () => {
    for (const upstreamStatus of [99, 600, 1.5, "502"]) {
      expect(
        sanitizeGuestSessionFailureDetails({
          reason: "upstream_status",
          upstreamStatus,
        }),
      ).toEqual({ reason: "upstream_status" });
    }
  });

  it("drops a network code that is not a plain error code", () => {
    for (const networkCode of ["bad code; x", "enotfound", "E", 42]) {
      expect(
        sanitizeGuestSessionFailureDetails({ reason: "network", networkCode }),
      ).toEqual({ reason: "network" });
    }
  });

  it("strips keys the contract does not allow", () => {
    expect(
      sanitizeGuestSessionFailureDetails({
        reason: "network",
        message: "getaddrinfo ENOTFOUND app.mcpjam.com",
        url: "https://app.mcpjam.com/api/web/guest-session",
      }),
    ).toEqual({ reason: "network" });
  });
});

describe("guestSessionFailureCode", () => {
  it("names a TLS failure on the server's upstream hop by its Node code", () => {
    expect(
      guestSessionFailureCode({
        httpStatus: 503,
        details: { reason: "network", networkCode: "SELF_SIGNED_CERT_IN_CHAIN" },
      }),
    ).toBe("guest_session/network/SELF_SIGNED_CERT_IN_CHAIN");
  });

  it("falls back to the reason for an unlisted network code", () => {
    expect(
      guestSessionFailureCode({
        httpStatus: 503,
        details: { reason: "network", networkCode: "ESOMETHINGNEW" },
      }),
    ).toBe("guest_session/network");
    expect(
      guestSessionFailureCode({ httpStatus: 503, details: { reason: "network" } }),
    ).toBe("guest_session/network");
  });

  it("gives every upstream reason a listed code", () => {
    for (const reason of GUEST_SESSION_FAILURE_REASONS) {
      expect(GUEST_SESSION_FAILURE_CODES).toContain(
        guestSessionFailureCode({ httpStatus: 503, details: { reason } }),
      );
    }
  });

  it("names failures that carry no upstream details", () => {
    expect(guestSessionFailureCode(undefined)).toBe("guest_session/exhausted");
    expect(guestSessionFailureCode({})).toBe("guest_session/unreachable");
    expect(guestSessionFailureCode({ httpStatus: 200 })).toBe(
      "guest_session/bad_response",
    );
    expect(guestSessionFailureCode({ httpStatus: 403 })).toBe(
      "guest_session/http_4xx",
    );
    expect(guestSessionFailureCode({ httpStatus: 502 })).toBe(
      "guest_session/http_5xx",
    );
  });
});
