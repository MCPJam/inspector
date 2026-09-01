import { describe, expect, it } from "vitest";
import { XAA_MCP_EXTENSION } from "@mcpjam/sdk";
import {
  applyHostConformanceKnobs,
  applyHostParamMirroring,
  conformanceKnobsFromMcpProfile,
  mirrorToolParamHeadersFromMcpProfile,
  resolveEffectiveAuthMethod,
  withXaaExtensionCapability,
  xaaConfigured,
  xaaPolicyRequiresConfiguration,
} from "../effective-auth";

const POLICY = { idp: "mcpjam" } as const;

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
      })
    ).toBe("xaa");
    // Sticky authServerMode WITHOUT a stored client id is not runnable XAA.
    expect(
      resolveEffectiveAuthMethod({
        authMethod: "auto",
        authServerMode: "mcpjam",
      })
    ).toBe("discover");
    expect(
      resolveEffectiveAuthMethod({ authMethod: "auto", clientId: "c1" })
    ).toBe("discover");
    expect(resolveEffectiveAuthMethod({ authMethod: "auto" })).toBe("discover");
  });

  it("canonical method wins over contradictory legacy booleans", () => {
    // A stale useOAuth:true must not drag an explicit xaa row into OAuth.
    expect(
      resolveEffectiveAuthMethod({ authMethod: "xaa", useOAuth: true })
    ).toBe("xaa");
    expect(
      resolveEffectiveAuthMethod({ authMethod: "none", useOAuth: true })
    ).toBe("none");
  });

  it("legacy rows fall back to the boolean pair with XAA-first precedence", () => {
    expect(resolveEffectiveAuthMethod({ useXaa: true, useOAuth: false })).toBe(
      "xaa"
    );
    // Historical gate: useXaa === true && useOAuth !== true → XAA; both set
    // is contradictory legacy state and resolves to OAuth (matching the old
    // `useOAuth !== true` guard).
    expect(resolveEffectiveAuthMethod({ useXaa: true, useOAuth: true })).toBe(
      "oauth"
    );
    expect(resolveEffectiveAuthMethod({ useOAuth: true })).toBe("oauth");
    expect(resolveEffectiveAuthMethod({})).toBe("none");
  });

  it("enterprise policy rewrites ONLY the auto branch", () => {
    // auto + policy → xaa regardless of configuration state.
    expect(resolveEffectiveAuthMethod({ authMethod: "auto" }, POLICY)).toBe(
      "xaa"
    );
    expect(
      resolveEffectiveAuthMethod(
        { authMethod: "auto", authServerMode: "mcpjam", clientId: "c1" },
        POLICY
      )
    ).toBe("xaa");
    // Explicit methods are per-server overrides — the policy never touches
    // them.
    expect(resolveEffectiveAuthMethod({ authMethod: "oauth" }, POLICY)).toBe(
      "oauth"
    );
    expect(resolveEffectiveAuthMethod({ authMethod: "bearer" }, POLICY)).toBe(
      "bearer"
    );
    expect(resolveEffectiveAuthMethod({ authMethod: "none" }, POLICY)).toBe(
      "none"
    );
    expect(resolveEffectiveAuthMethod({ authMethod: "xaa" }, POLICY)).toBe(
      "xaa"
    );
    // Legacy boolean rows behave as their canonical equivalents (overrides);
    // pre-`auto` relics resolving "none" by absence stay outside the policy.
    expect(resolveEffectiveAuthMethod({ useOAuth: true }, POLICY)).toBe(
      "oauth"
    );
    expect(resolveEffectiveAuthMethod({}, POLICY)).toBe("none");
    // No policy → identical to the one-arg form.
    expect(resolveEffectiveAuthMethod({ authMethod: "auto" }, undefined)).toBe(
      "discover"
    );
  });

  it("xaaPolicyRequiresConfiguration fires only for policy-forced unconfigured auto servers", () => {
    expect(xaaPolicyRequiresConfiguration({ authMethod: "auto" }, POLICY)).toBe(
      true
    );
    // Configured server mints normally.
    expect(
      xaaPolicyRequiresConfiguration(
        { authMethod: "auto", authServerMode: "mcpjam", clientId: "c1" },
        POLICY
      )
    ).toBe(false);
    // No policy → the discover ladder handles it.
    expect(
      xaaPolicyRequiresConfiguration({ authMethod: "auto" }, undefined)
    ).toBe(false);
    // Explicit xaa keeps its existing mint-failure path.
    expect(xaaPolicyRequiresConfiguration({ authMethod: "xaa" }, POLICY)).toBe(
      false
    );
    // Overrides are out of scope for the policy error.
    expect(
      xaaPolicyRequiresConfiguration({ authMethod: "oauth" }, POLICY)
    ).toBe(false);
  });

  it("xaaConfigured mirrors the backend derivation rule", () => {
    expect(xaaConfigured({ authServerMode: "mcpjam", clientId: "c1" })).toBe(
      true
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

/**
 * SEP-2243 mirroring is server-authoritative wherever a backend host config
 * exists. The direction that matters most is the one a half-implementation
 * misses: a host that says MIRROR must beat a body that says otherwise, or a
 * share-link caller could silently downgrade a conforming host into one that
 * omits the headers the server cross-checks.
 */
describe("mirrorToolParamHeadersFromMcpProfile", () => {
  it("reads only an explicit omit as suppression", () => {
    expect(
      mirrorToolParamHeadersFromMcpProfile({
        toolParamHeaderMirroring: "omit",
      })
    ).toBe(false);
    expect(
      mirrorToolParamHeadersFromMcpProfile({
        toolParamHeaderMirroring: "mirror",
      })
    ).toBeUndefined();
    expect(mirrorToolParamHeadersFromMcpProfile({})).toBeUndefined();
    expect(mirrorToolParamHeadersFromMcpProfile(undefined)).toBeUndefined();
    expect(mirrorToolParamHeadersFromMcpProfile(null)).toBeUndefined();
    // An unrecognized future literal means mirror, never suppression.
    expect(
      mirrorToolParamHeadersFromMcpProfile({
        toolParamHeaderMirroring: "corrupt",
      })
    ).toBeUndefined();
  });
});

describe("applyHostParamMirroring", () => {
  it("forces the pin off when the host says omit", () => {
    expect(applyHostParamMirroring(undefined, false)).toEqual({
      mirrorToolParamHeaders: false,
    });
    expect(
      applyHostParamMirroring({ protocolVersion: "2026-07-28" }, false)
    ).toEqual({
      protocolVersion: "2026-07-28",
      mirrorToolParamHeaders: false,
    });
  });

  it("strips a caller pin when the host says mirror", () => {
    // The whole point: a share-link body cannot make a conforming host
    // non-conforming.
    expect(
      applyHostParamMirroring(
        { protocolVersion: "2026-07-28", mirrorToolParamHeaders: false },
        undefined
      )
    ).toEqual({ protocolVersion: "2026-07-28" });
    expect(
      applyHostParamMirroring({ mirrorToolParamHeaders: false }, undefined)
    ).toEqual({});
  });

  it("leaves untouched pins alone", () => {
    const pins = { protocolVersion: "2026-07-28" };
    expect(applyHostParamMirroring(pins, undefined)).toBe(pins);
    expect(applyHostParamMirroring(undefined, undefined)).toBeUndefined();
  });
});

describe("conformanceKnobsFromMcpProfile — toolListChanged", () => {
  it("reads each false leaf", () => {
    expect(
      conformanceKnobsFromMcpProfile({
        toolListChanged: { listens: false, refetches: false },
      })
    ).toEqual({
      firstPageOnly: undefined,
      supportsMrtr: undefined,
      suppressListenChannel: true,
      dropToolListChanged: true,
    });
  });

  it("treats true leaves, an empty record and junk as conforming", () => {
    for (const toolListChanged of [
      { listens: true, refetches: true },
      {},
      null,
      "nope",
    ]) {
      const knobs = conformanceKnobsFromMcpProfile({ toolListChanged });
      expect(knobs.suppressListenChannel).toBeUndefined();
      expect(knobs.dropToolListChanged).toBeUndefined();
    }
  });
});

describe("applyHostConformanceKnobs — toolListChanged", () => {
  const conforming = {
    firstPageOnly: undefined,
    supportsMrtr: undefined,
    suppressListenChannel: undefined,
    dropToolListChanged: undefined,
    suppressLegacyRequestCancellation: undefined,
    suppressModernRequestCancellation: undefined,
  } as const;

  it("adds the host's knobs to a body that carried none", () => {
    expect(
      applyHostConformanceKnobs(undefined, {
        ...conforming,
        suppressListenChannel: true,
      })
    ).toEqual({ suppressListenChannel: true });
  });

  it("REMOVES a body-supplied knob when the host is conforming", () => {
    // The security property: a share-link body must not be able to silence a
    // conforming host's notifications by posting the pin itself.
    expect(
      applyHostConformanceKnobs(
        { suppressListenChannel: true, dropToolListChanged: true },
        conforming
      )
    ).toEqual({});
  });
});

describe("conformanceKnobsFromMcpProfile", () => {
  it("reads the non-default literals", () => {
    expect(
      conformanceKnobsFromMcpProfile({
        paginationTraversal: "firstPageOnly",
        mrtrSupport: "none",
      })
    ).toEqual({
      firstPageOnly: true,
      supportsMrtr: false,
      suppressListenChannel: undefined,
      dropToolListChanged: undefined,
      suppressLegacyRequestCancellation: undefined,
    suppressModernRequestCancellation: undefined,
    });
  });

  it("collapses the default literals, an absent profile and junk to undefined", () => {
    // Unreadable input must mean "behave conformantly", never the simulation.
    for (const profile of [
      { paginationTraversal: "full", mrtrSupport: "full" },
      { paginationTraversal: "sometimes", mrtrSupport: "partial" },
      {},
      undefined,
      null,
      "nope",
    ]) {
      expect(conformanceKnobsFromMcpProfile(profile)).toEqual({
        firstPageOnly: undefined,
        supportsMrtr: undefined,
        suppressListenChannel: undefined,
        dropToolListChanged: undefined,
        suppressLegacyRequestCancellation: undefined,
    suppressModernRequestCancellation: undefined,
      });
    }
  });
});

describe("conformanceKnobsFromMcpProfile — toolCallCancellation", () => {
  it("reads each era's leaf independently", () => {
    // The point of the record: a host measured as broken on 2026 must leave
    // 2025 untouched, and vice versa.
    const legacyBroken = conformanceKnobsFromMcpProfile({
      toolCallCancellation: { legacy: false },
    });
    expect(legacyBroken.suppressLegacyRequestCancellation).toBe(true);
    expect(legacyBroken.suppressModernRequestCancellation).toBeUndefined();

    const modernBroken = conformanceKnobsFromMcpProfile({
      toolCallCancellation: { modern: false },
    });
    expect(modernBroken.suppressModernRequestCancellation).toBe(true);
    expect(modernBroken.suppressLegacyRequestCancellation).toBeUndefined();
  });

  it("treats `true`, junk and a non-record as the conforming client", () => {
    for (const value of [
      { legacy: true, modern: true },
      { legacy: "false" },
      {},
      "nope",
      null,
      undefined,
    ]) {
      const knobs = conformanceKnobsFromMcpProfile({
        toolCallCancellation: value,
      });
      expect(knobs.suppressLegacyRequestCancellation).toBeUndefined();
      expect(knobs.suppressModernRequestCancellation).toBeUndefined();
    }
  });
});

describe("applyHostConformanceKnobs — toolCallCancellation", () => {
  const conforming = {
    firstPageOnly: undefined,
    supportsMrtr: undefined,
    suppressListenChannel: undefined,
    dropToolListChanged: undefined,
    suppressLegacyRequestCancellation: undefined,
    suppressModernRequestCancellation: undefined,
  } as const;

  it("adds only the era the host actually suppresses", () => {
    expect(
      applyHostConformanceKnobs(undefined, {
        ...conforming,
        suppressModernRequestCancellation: true,
      })
    ).toEqual({ suppressModernRequestCancellation: true });
  });

  it("REMOVES body-supplied suppression when the host cancels normally", () => {
    // Same security property as the sibling knobs: a share-link body must not
    // be able to make a conforming host silently abandon cancelled calls,
    // leaving servers running tools nobody wants.
    expect(
      applyHostConformanceKnobs(
        {
          suppressLegacyRequestCancellation: true,
          suppressModernRequestCancellation: true,
        },
        conforming
      )
    ).toEqual({});
  });
});
