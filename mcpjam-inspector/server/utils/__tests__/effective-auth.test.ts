import { describe, expect, it } from "vitest";
import { XAA_MCP_EXTENSION } from "@mcpjam/sdk";
import {
  resolveEffectiveAuthMethod,
  withXaaExtensionCapability,
  xaaConfigured,
} from "../effective-auth";

describe("resolveEffectiveAuthMethod", () => {
  it("passes explicit canonical methods through", () => {
    expect(resolveEffectiveAuthMethod({ authMethod: "oauth" })).toBe("oauth");
    expect(resolveEffectiveAuthMethod({ authMethod: "xaa" })).toBe("xaa");
    expect(resolveEffectiveAuthMethod({ authMethod: "bearer" })).toBe("bearer");
    expect(resolveEffectiveAuthMethod({ authMethod: "none" })).toBe("none");
  });

  it("auto selects XAA only when the server is fully XAA-configured", () => {
    expect(
      resolveEffectiveAuthMethod({
        authMethod: "auto",
        authServerMode: "mcpjam",
        clientId: "c1",
      }),
    ).toBe("xaa");
    // Sticky authServerMode WITHOUT a stored client id is not runnable XAA.
    expect(
      resolveEffectiveAuthMethod({
        authMethod: "auto",
        authServerMode: "mcpjam",
      }),
    ).toBe("discover");
    expect(
      resolveEffectiveAuthMethod({ authMethod: "auto", clientId: "c1" }),
    ).toBe("discover");
    expect(resolveEffectiveAuthMethod({ authMethod: "auto" })).toBe("discover");
  });

  it("canonical method wins over contradictory legacy booleans", () => {
    // A stale useOAuth:true must not drag an explicit xaa row into OAuth.
    expect(
      resolveEffectiveAuthMethod({ authMethod: "xaa", useOAuth: true }),
    ).toBe("xaa");
    expect(
      resolveEffectiveAuthMethod({ authMethod: "none", useOAuth: true }),
    ).toBe("none");
  });

  it("legacy rows fall back to the boolean pair with XAA-first precedence", () => {
    expect(
      resolveEffectiveAuthMethod({ useXaa: true, useOAuth: false }),
    ).toBe("xaa");
    // Historical gate: useXaa === true && useOAuth !== true → XAA; both set
    // is contradictory legacy state and resolves to OAuth (matching the old
    // `useOAuth !== true` guard).
    expect(resolveEffectiveAuthMethod({ useXaa: true, useOAuth: true })).toBe(
      "oauth",
    );
    expect(resolveEffectiveAuthMethod({ useOAuth: true })).toBe("oauth");
    expect(resolveEffectiveAuthMethod({})).toBe("none");
  });

  it("xaaConfigured mirrors the backend derivation rule", () => {
    expect(xaaConfigured({ authServerMode: "mcpjam", clientId: "c1" })).toBe(
      true,
    );
    expect(xaaConfigured({ authServerMode: "mcpjam" })).toBe(false);
    expect(xaaConfigured({ clientId: "c1" })).toBe(false);
  });
});

describe("withXaaExtensionCapability", () => {
  it("adds the enterprise-managed authorization extension to empty capabilities", () => {
    const caps = withXaaExtensionCapability(undefined);
    expect(caps.extensions).toEqual({ [XAA_MCP_EXTENSION]: {} });
  });

  it("merges — preserving existing capabilities and extensions", () => {
    const caps = withXaaExtensionCapability({
      sampling: {},
      extensions: { "vendor.example/custom": { pinned: true } },
    });
    expect(caps.sampling).toEqual({});
    expect(caps.extensions).toEqual({
      "vendor.example/custom": { pinned: true },
      [XAA_MCP_EXTENSION]: {},
    });
  });

  it("keeps an existing extension payload rather than overwriting it", () => {
    const caps = withXaaExtensionCapability({
      extensions: { [XAA_MCP_EXTENSION]: { configured: true } },
    });
    expect(caps.extensions).toEqual({
      [XAA_MCP_EXTENSION]: { configured: true },
    });
  });
});
