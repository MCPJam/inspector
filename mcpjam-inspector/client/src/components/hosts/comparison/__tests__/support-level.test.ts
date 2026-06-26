import { describe, expect, it } from "vitest";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import { hostConfigField } from "@/lib/host-config-field-schema";
import {
  getCapabilityCaveats,
  getSupportLevel,
  rowCoverage,
  rowPassesSupportFilter,
} from "../support-level";

function makeConfig(overrides: Partial<HostConfigDtoV2> = {}): HostConfigDtoV2 {
  return {
    id: "hc_test",
    schemaVersion: 2,
    hostStyle: "mcpjam",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "",
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

describe("getSupportLevel", () => {
  it("maps booleans to supported / neutral", () => {
    const f = hostConfigField("requireToolApproval");
    expect(getSupportLevel(f, makeConfig({ requireToolApproval: true }))).toBe(
      "supported",
    );
    expect(getSupportLevel(f, makeConfig({ requireToolApproval: false }))).toBe(
      "neutral",
    );
  });

  it("maps tri-state undefined (Auto) to partial", () => {
    const f = hostConfigField("progressiveToolDiscovery");
    expect(getSupportLevel(f, makeConfig())).toBe("partial");
    expect(
      getSupportLevel(f, makeConfig({ progressiveToolDiscovery: true })),
    ).toBe("supported");
    expect(
      getSupportLevel(f, makeConfig({ progressiveToolDiscovery: false })),
    ).toBe("neutral");
  });

  it("maps capability presence to supported, absence to neutral", () => {
    const f = hostConfigField("capabilities.sampling");
    expect(getSupportLevel(f, makeConfig({ clientCapabilities: {} }))).toBe(
      "neutral",
    );
    expect(
      getSupportLevel(f, makeConfig({ clientCapabilities: { sampling: {} } })),
    ).toBe("supported");
  });

  it("downgrades an advertised capability with listChanged:false to partial", () => {
    const f = hostConfigField("capabilities.roots");
    expect(
      getSupportLevel(
        f,
        makeConfig({ clientCapabilities: { roots: { listChanged: false } } }),
      ),
    ).toBe("partial");
  });

  it("returns null for scalar/data fields", () => {
    expect(getSupportLevel(hostConfigField("modelId"), makeConfig())).toBeNull();
    expect(
      getSupportLevel(hostConfigField("temperature"), makeConfig()),
    ).toBeNull();
  });
});

describe("rowCoverage", () => {
  it("counts supported hosts over total for a capability row", () => {
    const f = hostConfigField("capabilities.sampling");
    const configs = [
      makeConfig({ clientCapabilities: { sampling: {} } }),
      makeConfig({ clientCapabilities: {} }),
    ];
    expect(rowCoverage(f, configs)).toEqual({ supported: 1, total: 2 });
  });

  it("returns null for scalar rows", () => {
    expect(rowCoverage(hostConfigField("modelId"), [makeConfig()])).toBeNull();
  });
});

describe("rowPassesSupportFilter", () => {
  const sampling = hostConfigField("capabilities.sampling");
  const allAdvertise = [
    makeConfig({ clientCapabilities: { sampling: {} } }),
    makeConfig({ clientCapabilities: { sampling: {} } }),
  ];
  const oneMissing = [
    makeConfig({ clientCapabilities: { sampling: {} } }),
    makeConfig({ clientCapabilities: {} }),
  ];

  it("passes everything under 'all'", () => {
    expect(rowPassesSupportFilter(sampling, oneMissing, "all")).toBe(true);
    expect(
      rowPassesSupportFilter(hostConfigField("modelId"), oneMissing, "all"),
    ).toBe(true);
  });

  it("'missing' keeps rows not supported by every host", () => {
    expect(rowPassesSupportFilter(sampling, oneMissing, "missing")).toBe(true);
    expect(rowPassesSupportFilter(sampling, allAdvertise, "missing")).toBe(false);
  });

  it("'supported' keeps rows supported by every host", () => {
    expect(rowPassesSupportFilter(sampling, allAdvertise, "supported")).toBe(
      true,
    );
    expect(rowPassesSupportFilter(sampling, oneMissing, "supported")).toBe(false);
  });

  it("hides scalar rows under any non-'all' filter", () => {
    expect(
      rowPassesSupportFilter(hostConfigField("modelId"), oneMissing, "missing"),
    ).toBe(false);
  });
});

describe("getCapabilityCaveats", () => {
  it("flags an advertised capability without list-changed support", () => {
    const f = hostConfigField("capabilities.roots");
    const caveats = getCapabilityCaveats(
      f,
      makeConfig({ clientCapabilities: { roots: { listChanged: false } } }),
    );
    expect(caveats.length).toBeGreaterThanOrEqual(1);
    expect(caveats[0]).toMatch(/list-changed/i);
  });

  it("returns no caveats for a clean empty capability", () => {
    const f = hostConfigField("capabilities.sampling");
    expect(
      getCapabilityCaveats(f, makeConfig({ clientCapabilities: { sampling: {} } })),
    ).toEqual([]);
  });
});
