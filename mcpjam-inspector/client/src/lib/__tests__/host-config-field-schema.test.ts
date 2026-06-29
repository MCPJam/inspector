import { describe, expect, it } from "vitest";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import {
  fieldDiverges,
  groupHostConfigFields,
  hostConfigField,
  HOST_CONFIG_FIELDS,
  HOST_CONFIG_SECTIONS,
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
    const modelSampling = agent.subsections.find(
      (s) => s.label === "Model & sampling"
    );
    expect(modelSampling).toBeTruthy();
    expect(modelSampling!.fields.map((f) => f.id)).toEqual([
      "modelId",
      "temperature",
      "requireToolApproval",
      "respectToolVisibility",
      "modelVisibleMcpToolResults.directContent.image",
      "modelVisibleMcpToolResults.embeddedResources.blob.image",
      "modelVisibleMcpToolResults.linkedResources.blob.image",
      "mcpToolResultImageRendering",
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
      rendering.read(makeConfig({ mcpToolResultImageRendering: "panel" }))
    ).toBe("panel");
    expect(
      rendering.read(makeConfig({ mcpToolResultImageRendering: "none" }))
    ).toBe("none");
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
