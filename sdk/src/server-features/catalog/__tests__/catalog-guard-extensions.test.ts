import { describe, expect, it } from "vitest";
import { makeProbe, makeSurface } from "../../__tests__/fixtures.js";
import { EXTENSION_FEATURES } from "../extensions/index.js";
import {
  MODERN,
  declared,
  feature,
  probed,
  type ProbeOverrides,
  type ProbeValues,
} from "./extension-rule-helpers.js";

describe("extension catalog shape (families 18 to 24)", () => {
  it("names the setup for every feature assessed by configuration", () => {
    for (const entry of EXTENSION_FEATURES) {
      if (entry.assessment.primary === "configured") {
        expect(entry.assessment.setup, entry.id).toBeDefined();
      }
    }
  });
});

describe("authorization extensions", () => {
  const authProbe = (
    values: ProbeValues<"authorization">,
    overrides: ProbeOverrides<"authorization"> = {}
  ) => ({
    authorization: makeProbe(
      "authorization",
      { oauthRequired: true, asMetadataFound: true, ...values },
      overrides
    ),
  });

  it("reads client_credentials, token auth methods and ID-JAG from the metadata", () => {
    const probes = authProbe({
      grantTypesSupported: ["authorization_code", "client_credentials"],
      tokenEndpointAuthMethods: ["private_key_jwt"],
      authorizationGrantProfiles: [
        "urn:ietf:params:oauth:grant-profile:id-jag",
      ],
    });
    expect(probed("auth-ext.client-credentials.grant", probes)).toMatchObject({
      kind: "present",
      via: "probed",
    });
    expect(
      probed("auth-ext.client-credentials.token-auth-methods", probes)
    ).toMatchObject({ kind: "present" });
    expect(probed("auth-ext.xaa.id-jag-profile", probes)).toMatchObject({
      kind: "present",
    });
  });

  it("reports absence only from a complete metadata read", () => {
    const values = {
      grantTypesSupported: ["authorization_code", "refresh_token"],
    };
    expect(
      probed("auth-ext.client-credentials.grant", authProbe(values))
    ).toEqual({
      kind: "absent",
      basis: [],
      detail: "grant_types_supported lists authorization_code, refresh_token",
    });
    expect(
      probed(
        "auth-ext.client-credentials.grant",
        authProbe(values, { coverage: "partial" })
      )
    ).toMatchObject({
      kind: "unknown",
    });
    // An empty or missing list proves nothing (RFC 8414 defaults apply).
    expect(
      probed(
        "auth-ext.xaa.id-jag-profile",
        authProbe({ authorizationGrantProfiles: [] })
      )
    ).toMatchObject({
      kind: "unknown",
    });
  });

  it("keeps XAA advertised but denied as unknown, never unsupported", () => {
    const denied = authProbe(
      {
        authorizationGrantProfiles: [
          "urn:ietf:params:oauth:grant-profile:id-jag",
        ],
      },
      { status: "failed", detail: "token exchange denied by tenant policy" }
    );
    expect(probed("auth-ext.xaa.id-jag-profile", denied)).toMatchObject({
      kind: "unknown",
    });
    expect(probed("auth-ext.client-credentials.grant", denied)).toMatchObject({
      kind: "unknown",
    });
    for (const id of [
      "auth-ext.xaa.access",
      "auth-ext.xaa.token-exchange",
      "auth-ext.xaa.jwt-bearer",
      "auth-ext.xaa.saml",
    ]) {
      expect(feature(id).assessment).toMatchObject({
        primary: "configured",
        setup: "enterprise-managed-authorization",
      });
      expect(feature(id).assessment.probed).toBeUndefined();
    }
  });

  it("is not applicable without OAuth or on stdio, and silent without a probe", () => {
    expect(
      probed(
        "auth-ext.xaa.id-jag-profile",
        authProbe({ oauthRequired: false, oauthOptional: false })
      )
    ).toMatchObject({
      kind: "not-applicable",
    });
    expect(
      probed(
        "auth-ext.xaa.id-jag-profile",
        authProbe({}, { status: "not-applicable" })
      )
    ).toMatchObject({
      kind: "not-applicable",
    });
    expect(probed("auth-ext.xaa.id-jag-profile", {})).toBeNull();
  });

  it("is not applicable on stdio for every feature, like core authorization", () => {
    const family = EXTENSION_FEATURES.filter(
      (entry) => entry.family === "authorization-extensions"
    );
    expect(family.length).toBe(11);
    const stdio = makeSurface({ transport: "stdio", protocolVersion: MODERN });
    const http = makeSurface({ protocolVersion: MODERN });
    for (const entry of family) {
      expect(declared(entry.id, stdio), entry.id).toMatchObject({
        kind: "not-applicable",
      });
      expect(declared(entry.id, http)?.kind, entry.id).not.toBe(
        "not-applicable"
      );
    }
  });

  it("never treats a missing extension id in server/discover as a gap", () => {
    const withId = makeSurface({
      protocolVersion: MODERN,
      capabilities: {
        extensions: { "io.modelcontextprotocol/oauth-client-credentials": {} },
      },
    });
    expect(declared("auth-ext.discover-extension-ids", withId)).toMatchObject({
      kind: "present",
    });
    const without = makeSurface({
      protocolVersion: MODERN,
      capabilities: { extensions: {} },
    });
    expect(declared("auth-ext.discover-extension-ids", without)).toMatchObject({
      kind: "unknown",
    });
  });
});
