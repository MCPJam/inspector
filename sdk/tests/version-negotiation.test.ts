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

  it("enables automatic era negotiation when no pin is set (always on)", () => {
    // The manager applies this uniformly to HTTP and stdio, so an unconfigured
    // connection auto-negotiates on either transport.
    expect(resolveVersionNegotiation(undefined)).toEqual({ mode: "auto" });
  });

  it("an explicit modern pin negotiates modern with no legacy fallback", () => {
    // Checklist invariant: an explicit modern pin FAILS rather than silently
    // falling back to legacy — it maps to a hard pin, never `auto`/`undefined`.
    const out = resolveVersionNegotiation("2026-07-28");
    expect(out).toEqual({ mode: { pin: "2026-07-28" } });
    expect(out).not.toEqual({ mode: "auto" });
  });

  it("an explicit legacy pin stays byte-stable (exact initialize handshake)", () => {
    // Checklist invariant: `undefined` ⇒ the client runs the exact legacy
    // handshake for that pinned version, never a probe.
    expect(resolveVersionNegotiation("2025-11-25")).toBeUndefined();
  });

  it("returns a pin only for versions classified stateless/modern", () => {
    // Guards the mapping against a future protocol-version addition: any known
    // version either produces a modern pin or stays at the exact legacy
    // handshake, never a malformed shape.
    for (const v of MCP_PROTOCOL_VERSIONS) {
      const out = resolveVersionNegotiation(v);
      if (out !== undefined) {
        expect(out).toEqual({ mode: { pin: v } });
      }
    }
  });
});
