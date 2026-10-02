/**
 * The guest-session failure details cross into a browser-visible 503 body, so
 * this sanitizer is what keeps anything but closed values off the wire.
 */
import { describe, expect, it } from "vitest";
import { sanitizeGuestSessionFailureDetails } from "../guest-session-failure";

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
