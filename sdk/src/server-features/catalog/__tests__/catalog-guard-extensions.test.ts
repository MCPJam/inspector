import { describe, expect, it } from "vitest";
import { MCP_APPS_CHECK_IDS } from "../../../apps-conformance/types.js";
import { EVENTS_CHECK_IDS } from "../../../events-conformance/types.js";
import { MCP_UI_EXTENSION_ID } from "../../../mcp-client-manager/capabilities.js";
import { MCP_TASKS_CHECK_IDS } from "../../../tasks-conformance/types.js";
import {
  fullCoverage,
  makeProbe,
  makeSurface,
} from "../../__tests__/fixtures.js";
import { APPS_CHECK_FEATURES } from "../../check-map/apps.js";
import { EVENTS_CHECK_FEATURES } from "../../check-map/events.js";
import { TASKS_CHECK_FEATURES } from "../../check-map/tasks.js";
import type { CheckFeatureTarget } from "../../check-map/types.js";
import type { FeatureFamilyId } from "../../types.js";
import { SERVER_FEATURE_CATALOG } from "../index.js";
import { ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION_ID } from "../extensions/authorization.js";
import { evaluateServerFeatures } from "../../evaluate.js";
import { EXTENSION_FEATURES } from "../extensions/index.js";
import {
  MODERN,
  TASKS_CORE_VERSION,
  TASKS_EXT,
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

const LEAF_COUNTS: Partial<Record<FeatureFamilyId, number>> = {
  "authorization-extensions": 9,
  "mcp-apps": 20,
  tasks: 18,
  skills: 13,
  events: 12,
  "server-cards": 12,
  "third-party-experimental": 17,
};

const OBSERVABLE_IDS = [
  "apps.text-fallback",
  "apps.app-tools-call",
  "apps.app-resources-read",
  "apps.view-requests",
  "apps.view-notifications",
  "apps.host-notifications",
  "apps.display-modes",
  "apps.download-file-teardown",
  "apps.app-provided-tools",
  "tasks.core.augmented-call",
  "tasks.core.get",
  "tasks.core.result",
  "tasks.core.list",
  "tasks.core.cancel",
  "tasks.core.status-notification",
  "tasks.core.input-required",
  "tasks.ext.create-task-result",
  "tasks.ext.polling",
  "tasks.ext.update",
  "tasks.ext.cancel",
  "tasks.ext.notifications",
  "tasks.ext.missing-capability-error",
  "skills.get",
  "events.list-changed",
  "events.poll",
  "events.stream",
  "events.terminated",
  "events.cursor-replay",
  "events.error-codes",
  "openai.file-resources",
  "openai.model-context",
  "openai.message",
  "openai.files",
  "openai.elicitation",
];

describe("extension catalog shape (families 18 to 24)", () => {
  it("gives every family its inventory leaves", () => {
    const parents = new Set(EXTENSION_FEATURES.map((entry) => entry.parent));
    const counts: Partial<Record<FeatureFamilyId, number>> = {};
    for (const entry of EXTENSION_FEATURES) {
      if (parents.has(entry.id)) continue;
      counts[entry.family] = (counts[entry.family] ?? 0) + 1;
    }
    expect(counts).toEqual(LEAF_COUNTS);
  });

  it("names the setup for every feature assessed by configuration", () => {
    for (const entry of EXTENSION_FEATURES) {
      if (entry.assessment.primary === "configured") {
        expect(entry.assessment.setup, entry.id).toBeDefined();
      }
    }
  });

  it("pins the observable ids the traffic and Apps bridge classifier emits", () => {
    expect(
      EXTENSION_FEATURES.filter((entry) => entry.assessment.observable).map(
        (entry) => entry.id
      )
    ).toEqual(OBSERVABLE_IDS);
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

describe("check maps for the Apps, Tasks and Events suites", () => {
  const catalogIds = new Map(
    SERVER_FEATURE_CATALOG.map((entry) => [entry.id, entry.family])
  );
  const suites: Array<
    [
      string,
      readonly string[],
      Readonly<Record<string, CheckFeatureTarget>>,
      FeatureFamilyId,
    ]
  > = [
    ["apps", MCP_APPS_CHECK_IDS, APPS_CHECK_FEATURES, "mcp-apps"],
    ["tasks", MCP_TASKS_CHECK_IDS, TASKS_CHECK_FEATURES, "tasks"],
    ["events", EVENTS_CHECK_IDS, EVENTS_CHECK_FEATURES, "events"],
  ];

  it.each(suites)(
    "maps every %s check to existing features of its family",
    (_suite, ids, map, family) => {
      expect(Object.keys(map).sort()).toEqual([...ids].sort());
      for (const [checkId, target] of Object.entries(map)) {
        if (target === "excluded") continue;
        expect(target.length, checkId).toBeGreaterThan(0);
        for (const featureId of target) {
          expect(catalogIds.get(featureId), `${checkId} -> ${featureId}`).toBe(
            family
          );
        }
      }
    }
  );

  it("excludes checks that grade the client or a host, not the server", () => {
    // tasks-declaration-hygiene graded the client too; it was removed from the
    // suite rather than excluded, and its rule is a client test in CI.
    expect(Object.hasOwn(TASKS_CHECK_FEATURES, "tasks-declaration-hygiene")).toBe(
      false
    );
    expect(EVENTS_CHECK_FEATURES["chatgpt-readiness-webhook-listed"]).toBe(
      "excluded"
    );
    expect(EVENTS_CHECK_FEATURES["chatgpt-readiness-protocol-version"]).toBe(
      "excluded"
    );
    expect(EVENTS_CHECK_FEATURES["chatgpt-readiness-transport"]).toBe(
      "excluded"
    );
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
    // The metadata lists the grant; listing it is a declaration.
    expect(probed("auth-ext.client-credentials.grant", probes)).toMatchObject({
      kind: "present",
      via: "advertised",
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

  it("never credits XAA from setup or from an advertised extension", () => {
    // An enterprise host advertises the XAA extension even on a connect whose
    // own auth method skips XAA, so neither the extension nor setup is proof.
    const surface = makeSurface();
    const result = evaluateServerFeatures(SERVER_FEATURE_CATALOG, {
      connected: true,
      context: {
        transport: "streamable-http",
        protocolVersion: surface.protocolVersion,
        clientExtensions: [ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION_ID],
      },
      declared: { surface, capturedAt: 1 },
      configured: ["enterprise-managed-authorization"],
    });
    for (const id of ["auth-ext.xaa.access", "auth-ext.xaa.jwt-bearer"]) {
      expect(result.assessments[id]).toMatchObject({
        state: "not-checked",
        reason: "MCPJam cannot check this yet.",
      });
      expect(result.assessments[id].nextAction).toBeUndefined();
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
    // The read content declares permissions; the HTML check is a real read.
    expect(probed("apps.permissions", probes)).toMatchObject({
      kind: "present",
      via: "detected",
    });
    expect(probed("apps.html-content", probes)).toMatchObject({
      kind: "present",
      via: "probed",
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

describe("Tasks, per negotiated form", () => {
  const coreCapability = {
    list: {},
    cancel: {},
    requests: { tools: { call: {} } },
  };

  it("reads the core utility on 2025-11-25", () => {
    const surface = makeSurface({
      protocolVersion: TASKS_CORE_VERSION,
      capabilities: { tasks: coreCapability },
      tools: [
        { name: "slow", execution: { taskSupport: "optional" } },
        plainTool,
      ],
    });
    expect(declared("tasks.core.capability", surface)).toEqual({
      kind: "present",
      via: "advertised",
      detail: "list, cancel, requests.tools.call",
    });
    expect(declared("tasks.core.tool-task-support", surface)).toMatchObject({
      kind: "present",
      count: 1,
    });
    expect(declared("tasks.core.list", surface)).toMatchObject({
      kind: "present",
    });
    expect(declared("tasks.core.cancel", surface)).toMatchObject({
      kind: "present",
    });
    const experimental = makeSurface({
      protocolVersion: TASKS_CORE_VERSION,
      capabilities: { experimental: { tasks: { list: {} } } },
    });
    expect(declared("tasks.core.capability", experimental)).toMatchObject({
      kind: "present",
    });
  });

  it("makes the core capability the only gap when it is missing", () => {
    const surface = makeSurface({
      protocolVersion: TASKS_CORE_VERSION,
      capabilities: {},
    });
    expect(declared("tasks.core.capability", surface)).toEqual({
      kind: "absent",
      basis: ["capabilities"],
    });
    expect(declared("tasks.core.list", surface)).toMatchObject({
      kind: "not-applicable",
    });
    expect(declared("tasks.core.augmented-call", surface)).toMatchObject({
      kind: "not-applicable",
    });
    const partial = makeSurface({
      protocolVersion: TASKS_CORE_VERSION,
      capabilities: {},
      coverage: fullCoverage({ capabilities: "partial" }),
    });
    expect(declared("tasks.core.augmented-call", partial)).toBeNull();
  });

  it("does not count taskSupport forbidden or omitted as task support", () => {
    const surface = makeSurface({
      protocolVersion: TASKS_CORE_VERSION,
      capabilities: { tasks: coreCapability },
      tools: [
        { name: "a", execution: { taskSupport: "forbidden" } },
        plainTool,
      ],
    });
    expect(declared("tasks.core.tool-task-support", surface)).toEqual({
      kind: "absent",
      basis: ["tools"],
    });
  });

  it("reads the extension on 2026-07-28 and says nothing about which tools return tasks", () => {
    const surface = makeSurface({
      protocolVersion: MODERN,
      capabilities: { extensions: { [TASKS_EXT]: {} } },
    });
    expect(declared("tasks.ext.declaration", surface)).toMatchObject({
      kind: "present",
      via: "advertised",
    });
    // An ordinary result later does not undo the declaration; execution stays unobserved.
    expect(declared("tasks.ext.create-task-result", surface)).toBeNull();
    const without = makeSurface({
      protocolVersion: MODERN,
      capabilities: { extensions: {} },
    });
    expect(declared("tasks.ext.declaration", without)).toEqual({
      kind: "absent",
      basis: ["capabilities"],
    });
    expect(declared("tasks.ext.update", without)).toMatchObject({
      kind: "not-applicable",
    });
    const malformed = makeSurface({
      protocolVersion: MODERN,
      capabilities: { extensions: { [TASKS_EXT]: true } },
    });
    expect(declared("tasks.ext.declaration", malformed)).toMatchObject({
      kind: "unknown",
    });
  });

  it("scopes a server that advertises both forms to the negotiated revision", () => {
    const capabilities = {
      tasks: coreCapability,
      extensions: { [TASKS_EXT]: {} },
    };
    const legacy = makeSurface({
      protocolVersion: TASKS_CORE_VERSION,
      capabilities,
    });
    expect(declared("tasks.core.capability", legacy)).toMatchObject({
      kind: "present",
    });
    expect(declared("tasks.ext.declaration", legacy)).toBeNull();
    const modern = makeSurface({ protocolVersion: MODERN, capabilities });
    expect(declared("tasks.core.capability", modern)).toBeNull();
    expect(declared("tasks.ext.declaration", modern)).toMatchObject({
      kind: "present",
    });
    for (const surface of [legacy, modern]) {
      for (const entry of EXTENSION_FEATURES.filter(
        (item) => item.family === "tasks"
      )) {
        expect(entry.assessment.declared?.(surface)?.kind, entry.id).not.toBe(
          "absent"
        );
      }
    }
    expect(feature("tasks.core.capability").lifecycle).toEqual({
      introduced: "2025-11-25",
      removed: "2026-07-28",
    });
    expect(feature("tasks.ext.declaration").lifecycle).toEqual({
      introduced: "2026-07-28",
    });
  });

  it("never borrows rules for a missing or unknown revision", () => {
    for (const protocolVersion of [undefined, "2027-01-01"]) {
      const surface = makeSurface({
        protocolVersion,
        capabilities: { tasks: coreCapability },
      });
      expect(declared("tasks.core.capability", surface)).toMatchObject({
        kind: "unknown",
      });
      expect(declared("tasks.ext.declaration", surface)).toMatchObject({
        kind: "unknown",
      });
    }
  });
});
