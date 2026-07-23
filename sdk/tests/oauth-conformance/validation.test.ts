import { describe, expect, it } from "vitest";
import { normalizeOAuthConformanceConfig } from "../../src/oauth-conformance/validation.js";

describe("normalizeOAuthConformanceConfig CIMD gate", () => {
  it("accepts CIMD for 2026-07-28", () => {
    const normalized = normalizeOAuthConformanceConfig({
      serverUrl: "https://example.com/mcp",
      protocolVersion: "2026-07-28",
      registrationStrategy: "cimd",
    });
    expect(normalized.registrationStrategy).toBe("cimd");
  });

  it("accepts CIMD for 2025-11-25", () => {
    const normalized = normalizeOAuthConformanceConfig({
      serverUrl: "https://example.com/mcp",
      protocolVersion: "2025-11-25",
      registrationStrategy: "cimd",
    });
    expect(normalized.registrationStrategy).toBe("cimd");
  });

  it("rejects CIMD for versions whose spec has no CIMD (2025-06-18)", () => {
    expect(() =>
      normalizeOAuthConformanceConfig({
        serverUrl: "https://example.com/mcp",
        protocolVersion: "2025-06-18",
        registrationStrategy: "cimd",
      }),
    ).toThrow(/CIMD registration is not supported/);
  });
});
