import { describe, expect, it } from "vitest";
import {
  resolveActivatedVersionNegotiation,
  DEFAULT_VERSION_NEGOTIATION_ACTIVATION,
  type VersionNegotiationActivation,
} from "../src/mcp-client-manager/version-negotiation.js";
import { MCP_PROTOCOL_VERSIONS } from "../src/mcp-client-manager/mcp-protocol-version.js";

/**
 * Phase 5 exit-gate "Activation checklist" — proved at the resolver seam.
 *
 * `resolveActivatedVersionNegotiation` is the single point where the product
 * activation flag (default OFF) decides whether an UNCONFIGURED connection
 * reaches `versionNegotiation: { mode: "auto" }`. These tests pin every
 * checklist invariant that is expressible as a mapping from
 * (pin, transport, activation) → `ClientOptions.versionNegotiation`. The
 * end-to-end connect behaviors (double-spawn, real fallback, OAuth-401
 * unwrap) are covered in the manager integration test.
 */

const OFF: VersionNegotiationActivation = { enabled: false };
const ON: VersionNegotiationActivation = { enabled: true };

describe("resolveActivatedVersionNegotiation — flag OFF (default)", () => {
  it("defaults to OFF when no activation is passed (byte-identical to legacy)", () => {
    expect(DEFAULT_VERSION_NEGOTIATION_ACTIVATION.enabled).toBe(false);
    // No third argument → default policy → unconfigured HTTP is legacy, NOT auto.
    expect(
      resolveActivatedVersionNegotiation(undefined, "http")
    ).toBeUndefined();
    expect(
      resolveActivatedVersionNegotiation(undefined, "stdio")
    ).toBeUndefined();
  });

  it("unconfigured HTTP resolves to the legacy handshake, not auto", () => {
    expect(
      resolveActivatedVersionNegotiation(undefined, "http", OFF)
    ).toBeUndefined();
  });

  it("unconfigured stdio stays on the legacy initialize path (no probe)", () => {
    expect(
      resolveActivatedVersionNegotiation(undefined, "stdio", OFF)
    ).toBeUndefined();
  });

  it("explicit legacy pin stays byte-stable (undefined ⇒ exact handshake)", () => {
    expect(
      resolveActivatedVersionNegotiation("2025-11-25", "http", OFF)
    ).toBeUndefined();
    expect(
      resolveActivatedVersionNegotiation("2025-03-26", "http", OFF)
    ).toBeUndefined();
  });

  it("explicit modern pin still negotiates modern (fails, not falls back)", () => {
    // Even with activation OFF, an explicit modern pin is honored: the pin
    // makes the client negotiate exactly 2026 with no legacy fallback.
    expect(
      resolveActivatedVersionNegotiation("2026-07-28", "http", OFF)
    ).toEqual({ mode: { pin: "2026-07-28" } });
  });
});

describe("resolveActivatedVersionNegotiation — flag ON (activated)", () => {
  it("unconfigured HTTP auto-negotiates", () => {
    expect(resolveActivatedVersionNegotiation(undefined, "http", ON)).toEqual({
      mode: "auto",
    });
  });

  it("unconfigured stdio auto-negotiates (the double-spawn probe path)", () => {
    expect(resolveActivatedVersionNegotiation(undefined, "stdio", ON)).toEqual({
      mode: "auto",
    });
  });

  it("explicit modern pin still pins modern (no fallback)", () => {
    expect(
      resolveActivatedVersionNegotiation("2026-07-28", "http", ON)
    ).toEqual({ mode: { pin: "2026-07-28" } });
  });

  it("explicit legacy pin stays byte-stable even when activated", () => {
    expect(
      resolveActivatedVersionNegotiation("2025-11-25", "http", ON)
    ).toBeUndefined();
  });
});

describe("resolveActivatedVersionNegotiation — total mapping guard", () => {
  it("never produces a malformed shape for any known version / transport / flag", () => {
    for (const v of [undefined, ...MCP_PROTOCOL_VERSIONS] as const) {
      for (const transport of ["http", "stdio"] as const) {
        for (const activation of [OFF, ON]) {
          const out = resolveActivatedVersionNegotiation(
            v,
            transport,
            activation
          );
          if (out === undefined) continue;
          // Either the auto sentinel or an exact modern pin — nothing else.
          const isAuto = "mode" in out && out.mode === "auto";
          const isPin =
            "mode" in out &&
            typeof out.mode === "object" &&
            out.mode !== null &&
            "pin" in out.mode;
          expect(isAuto || isPin).toBe(true);
        }
      }
    }
  });

  it("the flag NEVER changes an explicit HTTP pin outcome", () => {
    // On HTTP an explicit pin is honored identically regardless of the flag —
    // the flag only governs the UNCONFIGURED case. (On stdio the flag also
    // decides whether negotiation happens AT ALL, so a stdio pin is not
    // flag-stable; the manager never supplies a stdio pin in practice.)
    for (const v of MCP_PROTOCOL_VERSIONS) {
      expect(resolveActivatedVersionNegotiation(v, "http", OFF)).toEqual(
        resolveActivatedVersionNegotiation(v, "http", ON)
      );
    }
  });
});
