import { describe, expect, it } from "vitest";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import {
  fieldDiverges,
  groupHostConfigFields,
  hostConfigField,
  HOST_CONFIG_FIELDS,
  HOST_CONFIG_SECTIONS,
  NOT_SUPPORTED,
  parseLightDarkPair,
  type HostConfigFieldDef,
} from "@/lib/host-config-field-schema";

function makeConfig(overrides: Partial<HostConfigDtoV2> = {}): HostConfigDtoV2 {
  return {
    id: "hc_test",
    schemaVersion: 2,
    hostStyle: "mcpjam",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "You are a helpful assistant.",
    temperature: 0.2,
    requireToolApproval: false,
    respectToolVisibility: true,
    serverIds: [],
    optionalServerIds: [],
    connectionDefaults: { headers: {}, requestTimeout: 60_000 },
    clientCapabilities: {},
    hostContext: {},
    ...overrides,
  } as HostConfigDtoV2;
}

function fieldById(id: string): HostConfigFieldDef {
  const f = HOST_CONFIG_FIELDS.find((x) => x.id === id);
  if (!f) throw new Error(`field ${id} not registered`);
  return f;
}

describe("HOST_CONFIG_SECTIONS", () => {
  it("mirrors the three focus-dialog tabs in order", () => {
    expect(HOST_CONFIG_SECTIONS.map((s) => s.id)).toEqual([
      "agent",
      "protocol",
      "apps",
    ]);
  });
});

describe("HOST_CONFIG_FIELDS labels", () => {
  it("every registered field has a non-empty user-friendly label", () => {
    // Regression guard: focus tabs and the matrix both read `field.label`
    // — a blank entry would render as an empty row label in both surfaces.
    for (const f of HOST_CONFIG_FIELDS) {
      expect(f.label, `field ${f.id} missing label`).toBeTruthy();
      expect(f.label.length, `field ${f.id} label is empty`).toBeGreaterThan(0);
    }
  });

  it("field ids are unique (lookup by id is unambiguous)", () => {
    const ids = HOST_CONFIG_FIELDS.map((f) => f.id);
    const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
    expect(dupes).toEqual([]);
  });
});

describe("hostConfigField()", () => {
  it("returns the registered definition by id", () => {
    const f = hostConfigField("temperature");
    expect(f.id).toBe("temperature");
    expect(f.label).toBe("Temperature");
  });

  it("throws on an unknown id so renames fail loudly at the call site", () => {
    expect(() => hostConfigField("does-not-exist")).toThrow(
      /unknown field id/i
    );
  });
});

describe("groupHostConfigFields", () => {
  it("groups every field under its declared section", () => {
    const groups = groupHostConfigFields();
    const totalFields = groups.reduce(
      (acc, g) => acc + g.subsections.reduce((a, s) => a + s.fields.length, 0),
      0
    );
    expect(totalFields).toBe(HOST_CONFIG_FIELDS.length);
  });

  it("preserves the order fields appear in the registry within each subsection", () => {
    const agent = groupHostConfigFields().find(
      (g) => g.section.id === "agent"
    )!;
    const agentTooling = agent.subsections.find(
      (s) => s.label === "Agent tooling"
    );
    expect(agentTooling).toBeTruthy();
    expect(agentTooling!.fields.map((f) => f.id)).toEqual([
      "modelId",
      "temperature",
      "requireToolApproval",
      "respectToolVisibility",
      "modelVisibleMcpToolResults.directContent.image",
      "modelVisibleMcpToolResults.embeddedResources.blob.image",
      "modelVisibleMcpToolResults.linkedResources.blob.image",
      "mcpToolResultImageRendering",
      "mcpToolResultImageRendering.directContent.image",
      "mcpToolResultImageRendering.embeddedResources.blob.image",
      "mcpToolResultImageRendering.linkedResources.blob.image",
      "progressiveToolDiscovery",
    ]);
  });
});

describe("MCP image policy fields", () => {
  it("default to enabled and read explicit image opt-outs", () => {
    const direct = fieldById("modelVisibleMcpToolResults.directContent.image");
    const embedded = fieldById(
      "modelVisibleMcpToolResults.embeddedResources.blob.image"
    );
    const linked = fieldById(
      "modelVisibleMcpToolResults.linkedResources.blob.image"
    );

    expect(direct.label).toBe("Make tool image content visible to model");
    expect(embedded.label).toBe(
      "Make embedded resource images visible to model"
    );
    expect(linked.label).toBe("Make resource link images visible to model");
    expect(direct.read(makeConfig())).toBe(true);
    expect(embedded.read(makeConfig())).toBe(true);
    expect(linked.read(makeConfig())).toBe(true);
    expect(
      direct.read(
        makeConfig({
          modelVisibleMcpToolResults: {
            directContent: { image: false },
          },
        })
      )
    ).toBe(false);
    expect(
      embedded.read(
        makeConfig({
          modelVisibleMcpToolResults: {
            embeddedResources: { blob: { image: false } },
          },
        })
      )
    ).toBe(false);
    expect(
      linked.read(
        makeConfig({
          modelVisibleMcpToolResults: {
            linkedResources: { blob: { image: false } },
          },
        })
      )
    ).toBe(false);
  });

  it("defaults MCP tool-result image rendering to inline and reads explicit modes", () => {
    const rendering = fieldById("mcpToolResultImageRendering");
    expect(rendering.label).toBe("Render tool images");
    expect(rendering.read(makeConfig())).toBe("inline");
    expect(
      rendering.read(
        makeConfig({
          mcpToolResultImageRendering: { placement: "collapsed" },
        })
      )
    ).toBe("collapsed");
    expect(
      rendering.read(
        makeConfig({ mcpToolResultImageRendering: { placement: "none" } })
      )
    ).toBe("none");
  });

  it("defaults MCP tool-result render sources to enabled and reads explicit opt-outs", () => {
    const direct = fieldById("mcpToolResultImageRendering.directContent.image");
    const embedded = fieldById(
      "mcpToolResultImageRendering.embeddedResources.blob.image"
    );
    const linked = fieldById(
      "mcpToolResultImageRendering.linkedResources.blob.image"
    );

    expect(direct.label).toBe("Render tool image content");
    expect(embedded.label).toBe("Render embedded resource images");
    expect(linked.label).toBe("Render resource link images");
    expect(direct.read(makeConfig())).toBe(true);
    expect(embedded.read(makeConfig())).toBe(true);
    expect(linked.read(makeConfig())).toBe(true);
    expect(
      direct.read(
        makeConfig({
          mcpToolResultImageRendering: {
            directContent: { image: false },
          },
        })
      )
    ).toBe(false);
    expect(
      embedded.read(
        makeConfig({
          mcpToolResultImageRendering: {
            embeddedResources: { blob: { image: false } },
          },
        })
      )
    ).toBe(false);
    expect(
      linked.read(
        makeConfig({
          mcpToolResultImageRendering: {
            linkedResources: { blob: { image: false } },
          },
        })
      )
    ).toBe(false);
  });
});

describe("fieldDiverges", () => {
  it("returns false for a single host (nothing to compare)", () => {
    expect(fieldDiverges(fieldById("modelId"), [makeConfig()])).toBe(false);
  });

  it("returns false when every host has the same scalar value", () => {
    const a = makeConfig({ temperature: 0.2 });
    const b = makeConfig({ temperature: 0.2 });
    expect(fieldDiverges(fieldById("temperature"), [a, b])).toBe(false);
  });

  it("returns true when scalar values differ", () => {
    const a = makeConfig({ temperature: 0.2 });
    const b = makeConfig({ temperature: 0.7 });
    expect(fieldDiverges(fieldById("temperature"), [a, b])).toBe(true);
  });

  it("treats undefined and an absent field as the same value", () => {
    // progressiveToolDiscovery is tri-state; undefined === undefined
    const a = makeConfig();
    const b = makeConfig();
    expect(fieldDiverges(fieldById("progressiveToolDiscovery"), [a, b])).toBe(
      false
    );
  });

  it("treats undefined as distinct from explicit false (preserves tri-state)", () => {
    // The matrix renders these differently (auto vs off), so the gutter
    // must light up. Regression guard against a future canonicalizer that
    // coerces undefined → false.
    const auto = makeConfig({ progressiveToolDiscovery: undefined });
    const off = makeConfig({ progressiveToolDiscovery: false });
    expect(
      fieldDiverges(fieldById("progressiveToolDiscovery"), [auto, off])
    ).toBe(true);
  });

  it("compares nested object values by stable canonical form", () => {
    // Same keys, different declaration order — should NOT diverge.
    const a = makeConfig({
      connectionDefaults: {
        headers: { "X-A": "1", "X-B": "2" },
        requestTimeout: 60_000,
      },
    });
    const b = makeConfig({
      connectionDefaults: {
        headers: { "X-B": "2", "X-A": "1" },
        requestTimeout: 60_000,
      },
    });
    expect(fieldDiverges(fieldById("connectionDefaults.headers"), [a, b])).toBe(
      false
    );
  });

  it("flags divergence on a nested mcpProfile field across hosts", () => {
    const a = makeConfig({
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2025-11-25",
      },
    });
    const b = makeConfig({
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2026-07-28",
      },
    });
    expect(fieldDiverges(fieldById("mcpProtocolVersion"), [a, b])).toBe(true);
  });

  it("coerces respectToolVisibility undefined → true so pre-feature rows don't show as diverging from a row that explicitly set true", () => {
    const preFeature = makeConfig({ respectToolVisibility: undefined });
    const explicitTrue = makeConfig({ respectToolVisibility: true });
    expect(
      fieldDiverges(fieldById("respectToolVisibility"), [
        preFeature,
        explicitTrue,
      ])
    ).toBe(false);
  });
});

describe("display-mode rows on a host that renders no MCP Apps", () => {
  const DISPLAY_MODE_FIELDS = [
    "appsCap.availableDisplayModes",
    "appsCap.widgetDisplayModeRequests",
  ] as const;

  it("reads as not supported once the catalog says the host renders nothing", () => {
    // The shared no-claims preset fills these two with `['inline']` and
    // `'accept'` because neither has an off-value the way the booleans do,
    // so without this a CLI client advertised display modes it cannot show.
    const cfg = makeConfig({
      hostStyle: "claude-code",
      rendersMcpApps: false,
    } as Partial<HostConfigDtoV2>);
    for (const id of DISPLAY_MODE_FIELDS) {
      expect(fieldById(id).read(cfg)).toBe(NOT_SUPPORTED);
    }
  });

  it("leaves a rendering host's real values alone", () => {
    const cfg = makeConfig({
      hostStyle: "claude",
      rendersMcpApps: true,
    } as Partial<HostConfigDtoV2>);
    for (const id of DISPLAY_MODE_FIELDS) {
      expect(fieldById(id).read(cfg)).not.toBe(NOT_SUPPORTED);
      expect(fieldById(id).read(cfg)).toBeDefined();
    }
  });

  it("shows the effective value when no catalog fact is carried", () => {
    // A host the user built: the resolver's answer is the only answer there
    // is, and blanking it would hide a real setting.
    const cfg = makeConfig({ hostStyle: "claude-code" });
    for (const id of DISPLAY_MODE_FIELDS) {
      expect(fieldById(id).read(cfg)).not.toBe(NOT_SUPPORTED);
    }
  });
});

describe("CSP subtype rows", () => {
  it("reads the preset's answers when the row stores no override", () => {
    // The sandbox proxy enforces the RESOLVED matrix, so a Goose row with no
    // stored override is still having every connect subtype blocked. Reading
    // the raw `mcpAppsOverrides` here reported "unknown" for exactly the
    // hosts this emulation targets.
    const cfg = makeConfig({ hostStyle: "goose" });
    expect(fieldById("appsCap.cspConnectDomains.fetch").read(cfg)).toBe(false);
    expect(fieldById("appsCap.cspConnectDomains.xhr").read(cfg)).toBe(false);
    expect(fieldById("appsCap.cspConnectDomains.websocket").read(cfg)).toBe(
      false
    );
    expect(fieldById("appsCap.cspResourceDomains.script").read(cfg)).toBe(
      false
    );
    // Counter-host: ChatGPT honors the whole connect directive.
    const chatgpt = makeConfig({ hostStyle: "chatgpt" });
    expect(fieldById("appsCap.cspConnectDomains.fetch").read(chatgpt)).toBe(
      true
    );
  });

  it("lets a stored override win over the preset", () => {
    const cfg = makeConfig({
      hostStyle: "goose",
      mcpProfile: {
        profileVersion: 1,
        apps: { mcpAppsOverrides: { cspConnectDomains: { fetch: true } } },
      },
    } as Partial<HostConfigDtoV2>);
    expect(fieldById("appsCap.cspConnectDomains.fetch").read(cfg)).toBe(true);
    // Untouched leaves keep the preset rather than collapsing to unknown.
    expect(fieldById("appsCap.cspConnectDomains.xhr").read(cfg)).toBe(false);
  });

  it("stays unknown on a preset with no subtype evidence", () => {
    const cfg = makeConfig({ hostStyle: "mcpjam" });
    expect(
      fieldById("appsCap.cspConnectDomains.fetch").read(cfg)
    ).toBeUndefined();
  });
});

describe("parseLightDarkPair", () => {
  it("splits on the top-level comma, not the ones inside rgba()", () => {
    expect(
      parseLightDarkPair(
        "light-dark(rgba(50, 102, 173, 1), rgba(128, 170, 221, 1))"
      )
    ).toEqual({
      light: "rgba(50, 102, 173, 1)",
      dark: "rgba(128, 170, 221, 1)",
    });
  });

  it("returns null for anything that is not a light-dark() call", () => {
    expect(parseLightDarkPair("#fff")).toBeNull();
    expect(
      parseLightDarkPair("color-mix(in oklab,#fff 0%,transparent)")
    ).toBeNull();
    // Malformed: one argument, so there is no pair to report.
    expect(parseLightDarkPair("light-dark(#fff)")).toBeNull();
    expect(parseLightDarkPair("light-dark(#fff, )")).toBeNull();
    // Three arguments — splitting on the first comma would invent a dark.
    expect(parseLightDarkPair("light-dark(#fff, #000, #333)")).toBeNull();
    // Unbalanced: ends in `)`, but that paren closes `rgb(`, not light-dark(.
    expect(parseLightDarkPair("light-dark(#fff, rgb(0,0,0)")).toBeNull();
    // Closes early, so the trailing text was never inside the call.
    expect(parseLightDarkPair("light-dark(#fff), rgb(0,0,0)")).toBeNull();
    // Three arguments — splitting on the first comma would invent a dark.
    expect(parseLightDarkPair("light-dark(#fff, #000, #333)")).toBeNull();
    // Unbalanced: ends in `)`, but that paren closes `rgb(`, not light-dark(.
    expect(parseLightDarkPair("light-dark(#fff, rgb(0,0,0)")).toBeNull();
    // Closes early, so the trailing text was never inside the call.
    expect(parseLightDarkPair("light-dark(#fff), rgb(0,0,0)")).toBeNull();
  });
});

describe("Apps · Styles rows", () => {
  const field = () => fieldById("styles.--color-text-info");

  it("reads a per-theme probe capture as the pair", () => {
    const cfg = makeConfig({
      styleVariablesByTheme: {
        light: { "--color-text-info": "#3a83f7" },
        dark: { "--color-text-info": "#539af8" },
      },
    } as Partial<HostConfigDtoV2>);
    expect(field().read(cfg)).toEqual({ light: "#3a83f7", dark: "#539af8" });
  });

  it("decodes a light-dark() host into the same pair shape, keeping the literal", () => {
    // The whole point of the normalization: this host and the one above are
    // stating the same fact, so the matrix must not render them differently.
    const cfg = makeConfig({
      hostContext: {
        styles: {
          variables: {
            "--color-text-info":
              "light-dark(rgba(50, 102, 173, 1), rgba(128, 170, 221, 1))",
          },
        },
      },
    });
    expect(field().read(cfg)).toEqual({
      light: "rgba(50, 102, 173, 1)",
      dark: "rgba(128, 170, 221, 1)",
      raw: "light-dark(rgba(50, 102, 173, 1), rgba(128, 170, 221, 1))",
    });
  });

  it("keeps a genuinely theme-agnostic value bare", () => {
    const cfg = makeConfig({
      hostContext: { styles: { variables: { "--color-text-info": "#fff" } } },
    });
    expect(field().read(cfg)).toEqual({ same: "#fff" });
  });

  it("reports an unsplittable value verbatim rather than guessing", () => {
    const cfg = makeConfig({
      hostContext: {
        styles: { variables: { "--color-text-info": "light-dark(#fff)" } },
      },
    });
    expect(field().read(cfg)).toEqual({ same: "light-dark(#fff)" });
  });
});
