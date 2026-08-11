import { describe, it, expect } from "vitest";
import { originOf } from "@mcpjam/sdk";
import { describeBackendStreamFailure } from "../mcpjam-stream-handler.js";

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
