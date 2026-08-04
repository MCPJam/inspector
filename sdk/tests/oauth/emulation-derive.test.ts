import { deriveOAuthEmulation } from "../../src/oauth/emulation/derive.js";
import { OAUTH_EMULATION_FIELDS } from "../../src/oauth/emulation/types.js";
import type {
  HostConfigOAuthProfileV1,
  HostConfigOAuthProfileV2,
} from "../../src/host-config/internal";
import {
  refuted,
  unverifiable,
  verified,
} from "../support/oauth-profiles.js";

const v2 = (
  fields: Omit<HostConfigOAuthProfileV2, "profileVersion">
): HostConfigOAuthProfileV2 => ({ profileVersion: 2, ...fields });

describe("deriveOAuthEmulation — evidence handling", () => {
  it("an empty profile derives no knobs, full not_modeled coverage, default ladder", () => {
    const out = deriveOAuthEmulation(v2({}));
    expect(out.protocolVersion).toBe("2025-11-25");
    expect(out.emulation).toEqual({});
    expect(out.coverageSummary).toBe("partial");
    expect(Object.values(out.coverage)).toEqual(
      Array(OAUTH_EMULATION_FIELDS.length).fill("not_modeled")
    );
    expect(out.divergences).toEqual([]);
  });

  it("unverifiable evidence is not_modeled — never a guessed knob", () => {
    const out = deriveOAuthEmulation(
      v2({ sendsResourceIndicator: unverifiable<boolean>() })
    );
    expect(out.emulation.sendResourceIndicator).toBeUndefined();
    expect(out.coverage.sendsResourceIndicator).toBe("not_modeled");
  });

  it("refuted evidence carries the TRUE value and is modeled like verified", () => {
    // e.g. the claim "client omits resource" was refuted → the client DOES
    // send it → value true.
    const out = deriveOAuthEmulation(
      v2({ sendsResourceIndicator: refuted(true) })
    );
    expect(out.emulation.sendResourceIndicator).toBe(true);
    expect(out.coverage.sendsResourceIndicator).toBe("modeled");
  });

  it("a fully-modeled profile reports complete coverage", () => {
    const out = deriveOAuthEmulation(
      v2({
        sendsResourceIndicator: verified(false),
        oauthSpecVersion: verified({
          basis: "constant" as const,
          revisions: ["2025-06-18"],
        }),
        protocolVersionPinning: verified({
          mode: "pinned" as const,
          version: "2025-03-26",
        }),
        scopeRequest: verified({ mode: "omit" as const }),
        dcrIdentity: verified({ clientName: "Emulated Client" }),
        tokenEndpointAuthMethod: verified("client_secret_post" as const),
        authModel: verified(["oauth2-dcr"]),
      })
    );
    expect(out.coverageSummary).toBe("complete");
    expect(out.emulation).toEqual({
      mcpProtocolVersion: "2025-03-26",
      sendResourceIndicator: false,
      scopeRequest: { mode: "omit" },
      dcrClientName: "Emulated Client",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(out.protocolVersion).toBe("2025-06-18");
  });
});

describe("deriveOAuthEmulation — ladder selection (oauthSpecVersion)", () => {
  it("constant: picks the highest mutually-supported revision, no divergence", () => {
    const out = deriveOAuthEmulation(
      v2({
        oauthSpecVersion: verified({
          basis: "constant" as const,
          revisions: ["2025-03-26", "2025-11-25", "2025-06-18"],
        }),
      })
    );
    expect(out.protocolVersion).toBe("2025-11-25");
    expect(out.divergences).toEqual([]);
  });

  it("constant, disjoint (2024-11-05 client): oldest ladder + version-narrowed divergence", () => {
    const out = deriveOAuthEmulation(
      v2({
        oauthSpecVersion: verified({
          basis: "constant" as const,
          revisions: ["2024-10-07", "2024-11-05"],
        }),
      })
    );
    expect(out.protocolVersion).toBe("2025-03-26");
    expect(out.divergences).toEqual([
      expect.objectContaining({
        kind: "version-narrowed",
        requested: "2024-11-05",
        used: "2025-03-26",
      }),
    ]);
    expect(out.coverage.oauthSpecVersion).toBe("modeled");
  });

  it("constant, future-only revision: newest supported ≤ claim", () => {
    const out = deriveOAuthEmulation(
      v2({
        oauthSpecVersion: verified({
          basis: "constant" as const,
          revisions: ["2027-01-01"],
        }),
      })
    );
    expect(out.protocolVersion).toBe("2026-07-28");
    expect(out.divergences[0]).toMatchObject({
      kind: "version-narrowed",
      requested: "2027-01-01",
      used: "2026-07-28",
    });
  });

  it("behavioral floor that is a supported version: used exactly, no divergence", () => {
    const out = deriveOAuthEmulation(
      v2({
        oauthSpecVersion: verified({
          basis: "behavioral" as const,
          minimumRevision: "2025-06-18",
        }),
      })
    );
    expect(out.protocolVersion).toBe("2025-06-18");
    expect(out.divergences).toEqual([]);
  });

  it("behavioral floor between supported versions: nearest supported ≥ floor, no divergence", () => {
    const out = deriveOAuthEmulation(
      v2({
        oauthSpecVersion: verified({
          basis: "behavioral" as const,
          minimumRevision: "2025-05-01",
        }),
      })
    );
    expect(out.protocolVersion).toBe("2025-06-18");
    expect(out.divergences).toEqual([]);
  });

  it("behavioral floor beyond the newest ladder: newest + divergence", () => {
    const out = deriveOAuthEmulation(
      v2({
        oauthSpecVersion: verified({
          basis: "behavioral" as const,
          minimumRevision: "2027-06-01",
        }),
      })
    );
    expect(out.protocolVersion).toBe("2026-07-28");
    expect(out.divergences[0]).toMatchObject({ kind: "version-narrowed" });
  });
});

describe("deriveOAuthEmulation — per-field knobs", () => {
  it("pinned protocolVersionPinning sets mcpProtocolVersion (free-string, Goose shape)", () => {
    const out = deriveOAuthEmulation(
      v2({
        oauthSpecVersion: verified({
          basis: "behavioral" as const,
          minimumRevision: "2025-06-18",
        }),
        protocolVersionPinning: verified({
          mode: "pinned" as const,
          version: "2025-03-26",
        }),
      })
    );
    // Split-revision client: PRM-era OAuth ladder, older pinned MCP wire.
    expect(out.protocolVersion).toBe("2025-06-18");
    expect(out.emulation.mcpProtocolVersion).toBe("2025-03-26");
  });

  it("negotiated pinning is modeled with no version override", () => {
    const out = deriveOAuthEmulation(
      v2({
        protocolVersionPinning: verified({ mode: "negotiated" as const }),
      })
    );
    expect(out.emulation.mcpProtocolVersion).toBeUndefined();
    expect(out.coverage.protocolVersionPinning).toBe("modeled");
  });

  it("scopeRequest and tokenEndpointAuthMethod pass through verbatim", () => {
    const out = deriveOAuthEmulation(
      v2({
        scopeRequest: verified({
          mode: "fixed" as const,
          scopes: ["mcp:read", "mcp:write"],
        }),
        tokenEndpointAuthMethod: verified("client_secret_basic" as const),
      })
    );
    expect(out.emulation.scopeRequest).toEqual({
      mode: "fixed",
      scopes: ["mcp:read", "mcp:write"],
    });
    expect(out.emulation.tokenEndpointAuthMethod).toBe("client_secret_basic");
  });

  it("dcrIdentity maps clientName + userAgent, and captures redirectUris for the runner", () => {
    const withName = deriveOAuthEmulation(
      v2({
        dcrIdentity: verified({
          clientName: "Real Client",
          userAgent: "RealClient/1.2.3",
          redirectUris: ["https://client.example/cb"],
        }),
      })
    );
    expect(withName.emulation.dcrClientName).toBe("Real Client");
    expect(withName.emulation.userAgent).toBe("RealClient/1.2.3");
    expect(withName.coverage.dcrIdentity).toBe("modeled");
    expect(withName.divergences).toEqual([]);
    // Captured, but NOT compiled into a wire knob: replaying these alone
    // would send the code somewhere MCPJam cannot receive it. The runner
    // combines them with its own callback and declares the addition.
    expect(withName.capturedRedirectUris).toEqual([
      "https://client.example/cb",
    ]);
    expect(withName.emulation.dcrRedirectUris).toBeUndefined();

    const onlyRedirects = deriveOAuthEmulation(
      v2({
        dcrIdentity: verified({
          redirectUris: ["https://client.example/cb"],
        }),
      })
    );
    expect(onlyRedirects.emulation.dcrClientName).toBeUndefined();
    expect(onlyRedirects.coverage.dcrIdentity).toBe("modeled");
    expect(onlyRedirects.capturedRedirectUris).toEqual([
      "https://client.example/cb",
    ]);
    expect(onlyRedirects.divergences).toEqual([]);
  });
});

describe("deriveOAuthEmulation — V1 profiles", () => {
  it("V1 rows derive their shared fields; V2-only fields are not_modeled", () => {
    const profile: HostConfigOAuthProfileV1 = {
      profileVersion: 1,
      sendsResourceIndicator: verified(false),
      dcrIdentity: verified({ clientName: "V1 Client" }),
    };
    const out = deriveOAuthEmulation(profile);
    expect(out.emulation.sendResourceIndicator).toBe(false);
    expect(out.emulation.dcrClientName).toBe("V1 Client");
    expect(out.coverage.scopeRequest).toBe("not_modeled");
    expect(out.coverage.tokenEndpointAuthMethod).toBe("not_modeled");
    expect(out.coverageSummary).toBe("partial");
  });

  it("is deterministic — same profile in, same derivation out", () => {
    const profile = v2({
      sendsResourceIndicator: verified(true),
      scopeRequest: verified({ mode: "challenge" as const }),
    });
    expect(deriveOAuthEmulation(profile)).toEqual(
      deriveOAuthEmulation(structuredClone(profile))
    );
  });
});
