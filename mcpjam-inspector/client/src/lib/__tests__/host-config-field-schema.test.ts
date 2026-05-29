import { describe, expect, it } from "vitest";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import {
  fieldDiverges,
  groupHostConfigFields,
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

describe("groupHostConfigFields", () => {
  it("groups every field under its declared section", () => {
    const groups = groupHostConfigFields();
    const totalFields = groups.reduce(
      (acc, g) => acc + g.subsections.reduce((a, s) => a + s.fields.length, 0),
      0,
    );
    expect(totalFields).toBe(HOST_CONFIG_FIELDS.length);
  });

  it("preserves the order fields appear in the registry within each subsection", () => {
    const agent = groupHostConfigFields().find((g) => g.section.id === "agent")!;
    const modelSampling = agent.subsections.find(
      (s) => s.label === "Model & sampling",
    );
    expect(modelSampling).toBeTruthy();
    expect(modelSampling!.fields.map((f) => f.id)).toEqual([
      "modelId",
      "temperature",
      "requireToolApproval",
      "respectToolVisibility",
      "progressiveToolDiscovery",
    ]);
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
      false,
    );
  });

  it("treats undefined as distinct from explicit false (preserves tri-state)", () => {
    // The matrix renders these differently (auto vs off), so the gutter
    // must light up. Regression guard against a future canonicalizer that
    // coerces undefined → false.
    const auto = makeConfig({ progressiveToolDiscovery: undefined });
    const off = makeConfig({ progressiveToolDiscovery: false });
    expect(fieldDiverges(fieldById("progressiveToolDiscovery"), [auto, off]))
      .toBe(true);
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
    expect(fieldDiverges(fieldById("connectionDefaults.headers"), [a, b]))
      .toBe(false);
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
    expect(fieldDiverges(fieldById("respectToolVisibility"), [preFeature, explicitTrue]))
      .toBe(false);
  });
});
