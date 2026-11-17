import { describe, expect, it } from "vitest";
import { MCP_UI_EXTENSION_ID } from "../../../mcp-client-manager/capabilities.js";
import {
  fullCoverage,
  makeProbe,
  makeSurface,
} from "../../__tests__/fixtures.js";
import { EXTENSION_FEATURES } from "../extensions/index.js";
import {
  MODERN,
  declared,
  feature,
  plainTool,
  probed,
  type ProbeOverrides,
  type ProbeValues,
} from "./extension-rule-helpers.js";

const uiTool = {
  name: "show_chart",
  _meta: {
    ui: { resourceUri: "ui://chart/view", visibility: ["model", "app"] },
  },
};
const uiResource = {
  uri: "ui://chart/view",
  name: "chart",
  mimeType: "text/html;profile=mcp-app",
  _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] } } },
};

describe("extension catalog shape (families 18 to 24)", () => {
  it("names the setup for every feature assessed by configuration", () => {
    for (const entry of EXTENSION_FEATURES) {
      if (entry.assessment.primary === "configured") {
        expect(entry.assessment.setup, entry.id).toBeDefined();
      }
    }
  });

  it("marks every server-owned Apps row that can be absent as client dependent", () => {
    const appsRules = EXTENSION_FEATURES.filter(
      (entry) =>
        entry.family === "mcp-apps" &&
        entry.owner === "server" &&
        (entry.assessment.declared || entry.assessment.probed) &&
        entry.id !== "apps.legacy-resource-uri"
    );
    expect(appsRules.length).toBeGreaterThan(5);
    for (const entry of appsRules) {
      expect(entry.assessment.requiresClientExtension, entry.id).toBe(
        MCP_UI_EXTENSION_ID
      );
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

describe("MCP Apps", () => {
  it("detects views from tool metadata and UI resources", () => {
    const surface = makeSurface({
      tools: [uiTool, plainTool],
      resources: [uiResource],
    });
    expect(declared("apps.ui-resource", surface)).toMatchObject({
      kind: "present",
      via: "detected",
      count: 1,
    });
    expect(declared("apps.tool-resource-uri", surface)).toEqual({
      kind: "present",
      via: "detected",
      count: 1,
      detail: "1 of 2 tools",
    });
    expect(declared("apps.visibility", surface)).toMatchObject({
      kind: "present",
      count: 1,
    });
    expect(declared("apps.csp", surface)).toMatchObject({
      kind: "present",
      via: "detected",
    });
  });

  it("finds a view linked from a tool even when resources/list leaves it out", () => {
    const surface = makeSurface({ tools: [uiTool], resources: [] });
    expect(declared("apps.ui-resource", surface)).toMatchObject({
      kind: "present",
      detail: "Linked from tool metadata and not listed in resources/list",
    });
  });

  it("names the coverage an absence depends on and marks it client dependent", () => {
    // What a server that hides UI tools from a client without Apps returns.
    const surface = makeSurface({ tools: [plainTool] });
    expect(declared("apps.tool-resource-uri", surface)).toEqual({
      kind: "absent",
      basis: ["tools", "toolMeta"],
    });
    expect(declared("apps.ui-resource", surface)).toEqual({
      kind: "absent",
      basis: ["resources", "tools", "toolMeta"],
    });
    expect(
      feature("apps.tool-resource-uri").assessment.requiresClientExtension
    ).toBe(MCP_UI_EXTENSION_ID);
    // The client's own declaration is client owned and has no server rule.
    expect(feature("apps.client-ui-capability")).toMatchObject({
      owner: "client",
      assessment: { primary: "declared" },
    });
    expect(
      feature("apps.client-ui-capability").assessment.declared
    ).toBeUndefined();
  });

  it("does not read dropped metadata or a partial tool list as no tools", () => {
    const dropped = makeSurface({
      tools: [plainTool],
      coverage: fullCoverage({ toolMeta: "partial" }),
    });
    expect(declared("apps.tool-resource-uri", dropped)).toMatchObject({
      kind: "absent",
      basis: ["tools", "toolMeta"],
    });
    expect(declared("apps.legacy-resource-uri", dropped)).toBeNull();
    const partialList = makeSurface({
      tools: [],
      coverage: fullCoverage({ tools: "partial" }),
    });
    expect(declared("apps.tool-resource-uri", partialList)).toMatchObject({
      kind: "absent",
    });
    const noTools = makeSurface({ tools: [] });
    expect(declared("apps.tool-resource-uri", noTools)).toMatchObject({
      kind: "not-applicable",
    });
  });

  it("separates relying on the deprecated key from the SDK mirroring it", () => {
    const legacyOnly = makeSurface({
      tools: [{ name: "a", _meta: { "ui/resourceUri": "ui://a" } }],
    });
    expect(declared("apps.legacy-resource-uri", legacyOnly)).toMatchObject({
      kind: "present",
      count: 1,
    });
    expect(declared("apps.tool-resource-uri", legacyOnly)).toMatchObject({
      kind: "absent",
    });
    const mirrored = makeSurface({
      tools: [
        {
          name: "a",
          _meta: { ui: { resourceUri: "ui://a" }, "ui/resourceUri": "ui://a" },
        },
      ],
    });
    expect(declared("apps.legacy-resource-uri", mirrored)).toMatchObject({
      kind: "not-applicable",
    });
    expect(
      declared("apps.legacy-resource-uri", makeSurface({ tools: [plainTool] }))
    ).toMatchObject({
      kind: "not-applicable",
    });
  });

  it("does not count the default visibility as declared", () => {
    const surface = makeSurface({
      tools: [{ name: "a", _meta: { ui: { resourceUri: "ui://a" } } }],
    });
    expect(declared("apps.visibility", surface)).toMatchObject({
      kind: "absent",
    });
  });

  it("keeps tool links, resource policy and bridge messages as separate rows", () => {
    const surface = makeSurface({
      tools: [uiTool],
      resources: [{ ...uiResource, _meta: undefined }],
    });
    const probes = {
      "apps-ui-resources": makeProbe("apps-ui-resources", {
        uiResourceCount: 1,
        readCount: 1,
        readFailures: 0,
        htmlProfileOk: true,
        cspDeclared: false,
        permissionsDeclared: true,
      }),
    };
    expect(declared("apps.tool-resource-uri", surface)).toMatchObject({
      kind: "present",
    });
    expect(declared("apps.csp", surface)).toBeNull();
    expect(probed("apps.csp", probes)).toEqual({ kind: "absent", basis: [] });
    expect(probed("apps.permissions", probes)).toMatchObject({
      kind: "present",
      via: "probed",
    });
    expect(probed("apps.html-content", probes)).toMatchObject({
      kind: "present",
    });
    for (const id of [
      "apps.app-tools-call",
      "apps.view-requests",
      "apps.host-notifications",
    ]) {
      expect(feature(id).assessment).toEqual({
        primary: "observed",
        observable: true,
      });
    }
  });

  it("never reads failed or abandoned resource reads as missing policy", () => {
    const probe = (values: ProbeValues<"apps-ui-resources">) => ({
      "apps-ui-resources": makeProbe("apps-ui-resources", values),
    });
    expect(probed("apps.csp", probe({ uiResourceCount: 0 }))).toMatchObject({
      kind: "not-applicable",
    });
    expect(
      probed(
        "apps.csp",
        probe({ uiResourceCount: 1, readCount: 0, abandonedInputRequired: 1 })
      )
    ).toEqual({
      kind: "unknown",
      reason:
        "Reading the UI resources stopped because the server asked for input.",
    });
    expect(
      probed(
        "apps.csp",
        probe({
          uiResourceCount: 2,
          readCount: 1,
          readFailures: 1,
          cspDeclared: false,
        })
      )
    ).toMatchObject({
      kind: "unknown",
    });
    expect(
      probed(
        "apps.html-content",
        probe({ uiResourceCount: 1, readCount: 1, htmlProfileOk: false })
      )
    ).toMatchObject({
      kind: "unknown",
    });
  });
});
