import { describe, it, expect } from "vitest";
import { originOf } from "@mcpjam/sdk";
import {
  describeBackendStreamFailure,
  isUserOwnedDenialCode,
} from "../mcpjam-stream-handler.js";

describe("describeBackendStreamFailure", () => {
  it("owns a 5xx from MCPJam's own backend", () => {
    // The reported bug: a chat turn dying on a hosted 502. There is no Error
    // object at this site — only a non-OK Response — so nothing in the
    // describer can reach it, and before this the user got a raw string with
    // no way to tell our outage from their server's.
    const normalized = describeBackendStreamFailure(502, "Bad Gateway");

    expect(originOf(normalized)).toBe("mcpjam");
  });

  it.each([500, 503, 504])("owns a %i the same way", (status) => {
    expect(originOf(describeBackendStreamFailure(status, "boom"))).toBe("mcpjam");
  });

  it.each([401, 403])(
    "reads a %i as a provider credential wall, not an MCPJam outage",
    (status) => {
      const normalized = describeBackendStreamFailure(status, "invalid api key");

      expect(normalized.slug).toBe("provider/auth_error");
      // Defaults to the BYO reading: the key's owner is not plumbed to this
      // layer, and staying quiet is the safe direction to be wrong in.
      expect(originOf(normalized)).toBe("user_config");
    },
  );

  it("reads a 429 as a quota wall", () => {
    const normalized = describeBackendStreamFailure(429, "rate limited");

    expect(normalized.slug).toBe("provider/quota");
    expect(originOf(normalized)).toBe("user_config");
  });

  it("makes no claim about a 4xx it does not recognize", () => {
    const normalized = describeBackendStreamFailure(400, "bad request");

    expect(originOf(normalized)).toBe("ambiguous");
  });

  it("makes no claim when there is no status at all", () => {
    expect(originOf(describeBackendStreamFailure(undefined, "???"))).toBe(
      "ambiguous",
    );
  });

  it("keeps the status and body in the message for debugging", () => {
    const normalized = describeBackendStreamFailure(502, "upstream gone");

    expect(normalized.rawMessage).toContain("502");
    expect(normalized.rawMessage).toContain("upstream gone");
  });
});

describe("isUserOwnedDenialCode", () => {
  it.each(["user_rate_limit", "wallet_locked", "billing_limit_reached"])(
    "exempts the routine 200 denial %s from the internal boundary",
    (code) => {
      // These are the backend working correctly and refusing a request for a
      // user-owned reason. Declaring an internal boundary on them would page
      // the team on every ordinary spend-limit rejection.
      expect(isUserOwnedDenialCode(code)).toBe(true);
    },
  );

  it.each(["mcpjam_rate_limit", "mcpjam_api_error", "mcpjam_config_error"])(
    "does NOT exempt %s, which names US as the responsible party",
    (code) => {
      // The backend's error-code union includes these. A rule of "has any code
      // at all" would exempt precisely the failures most worth paging on.
      expect(isUserOwnedDenialCode(code)).toBe(false);
    },
  );

  it("does not exempt an unrecognized or absent code", () => {
    // An unknown code at HTTP 200 from OUR OWN backend is treated as a fault.
    // A missing entry here costs one investigated alert; the permissive rule
    // costs the blindness this work exists to remove.
    expect(isUserOwnedDenialCode("something_new")).toBe(false);
    expect(isUserOwnedDenialCode(undefined)).toBe(false);
  });
});
