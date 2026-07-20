import { describe, expect, it } from "vitest";
import { resolveVersionNegotiation } from "../src/mcp-client-manager/version-negotiation.js";
import { MCP_PROTOCOL_VERSIONS } from "../src/mcp-client-manager/mcp-protocol-version.js";

describe("resolveVersionNegotiation", () => {
  it("pins the modern era for a 2026-07-28 pin", () => {
    expect(resolveVersionNegotiation("2026-07-28")).toEqual({
      mode: { pin: "2026-07-28" },
    });
  });

  it("leaves negotiation at the SDK default (undefined) for every stateful pin", () => {
    expect(resolveVersionNegotiation("2025-11-25")).toBeUndefined();
    expect(resolveVersionNegotiation("2025-06-18")).toBeUndefined();
    expect(resolveVersionNegotiation("2025-03-26")).toBeUndefined();
  });

  it("leaves negotiation at the SDK default when no pin is set", () => {
    expect(resolveVersionNegotiation(undefined)).toBeUndefined();
  });

  it("returns a pin only for versions classified stateless/modern", () => {
    // Guards the mapping against a future protocol-version addition: any known
    // version either produces a modern pin or stays at the legacy default,
    // never a malformed shape.
    for (const v of MCP_PROTOCOL_VERSIONS) {
      const out = resolveVersionNegotiation(v);
      if (out !== undefined) {
        expect(out).toEqual({ mode: { pin: v } });
      }
    }
  });
});
