import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";
import { describe, expect, it } from "vitest";
import {
  hostConfigField,
  NOT_SUPPORTED,
  type HostConfigDtoWithCatalogFacts,
  type HostComparisonSubject,
} from "@/lib/host-config-field-schema";
import { capabilityCoverage, capabilitySlices } from "../caniuse-coverage";
import { buildPresetCompareEntries } from "../host-compare-presets";

const { subjects } = buildPresetCompareEntries(bundledHostCompatCatalog());
const clients = Object.values(subjects);
const probed = clients.filter(
  ({ hostId, config }) =>
    hostId !== "preset:mcpjam" &&
    (config as HostConfigDtoWithCatalogFacts).provenance === "probe",
);

describe("caniuse adoption", () => {
  it("distinguishes missing observations from styles measured as absent", () => {
    const field = {
      ...hostConfigField("styles.--color-background-primary"),
      read: (config: HostComparisonSubject["config"]) =>
        config.id === "preset:claude" ? NOT_SUPPORTED : undefined,
    };
    const result = capabilityCoverage(field, [subjects["preset:claude"], subjects["preset:cursor"]]);
    expect(result.rows.map(({ status }) => status)).toEqual(["unsupported", "unknown"]);
    expect(result).toMatchObject({ full: 0, published: 1, probed: 2, score: 0 });
  });

  it("records zero confirmed support separately from zero published results", () => {
    const field = hostConfigField("appsCap.cspConnectDomains.fetch");
    expect(
      capabilityCoverage({ ...field, read: () => undefined }, clients),
    ).toMatchObject({ probed: probed.length, published: 0, score: null });
  });

  it("counts inline-only widget rendering for its slice but not for full display-mode support", () => {
    const field = {
      ...hostConfigField("appsCap.availableDisplayModes"),
      read: () => ["inline"],
    };
    expect(capabilityCoverage(field, clients).score).toBe(0);
    expect(capabilityCoverage(field, clients, "inline").score).toBe(100);
  });

  it("counts partial and missing results for probed clients and excludes other profiles", () => {
    const sampling = hostConfigField("capabilities.sampling");
    const values = [true, undefined, false, true, true, true];
    const ids = ["claude", "cursor", "mistral", "chatgpt", "mcpjam", "opencode"];
    const field = {
      ...sampling,
      read: (config: HostComparisonSubject["config"]) => {
        const index = ids.indexOf(config.id.replace("preset:", ""));
        const value = values[index];
        return value === undefined
          ? { listChanged: false }
          : value
            ? {}
            : undefined;
      },
    };
    const coverage = capabilityCoverage(
      field,
      ids.map((id) => {
        const subject = subjects[`preset:${id}`];
        const config: HostConfigDtoWithCatalogFacts = {
          ...subject.config,
          provenance: id === "opencode" ? "assumed" : "probe",
        };
        return { ...subject, config };
      }),
    );
    expect(coverage).toMatchObject({ full: 2, probed: 4, score: 50 });
    expect(coverage.probedRows.map(({ status }) => status)).toEqual([
      "supported",
      "partial",
      "unsupported",
      "supported",
    ]);
  });

  it("treats any published Events mode as adoption and measures individual modes independently", () => {
    const field = hostConfigField("eventsDeliveryModes");
    const coverage = capabilityCoverage(field, clients);
    const known = probed.filter(({ config }) => Array.isArray(field.read(config)));
    expect(known.length).toBeGreaterThan(0);
    expect(coverage).toMatchObject({ probed: probed.length, published: known.length });
    expect(coverage.probed).toBeGreaterThan(coverage.published);
    const [any, ...modes] = capabilitySlices(field, clients);
    expect(any).toBe("any");
    for (const mode of modes) {
      expect(capabilityCoverage(field, clients, mode).probed).toBe(probed.length);
    }
  });

  it("computes coverage for every protocol revision from published version lists", () => {
    const field = hostConfigField("supportedProtocolVersions");
    const versions = capabilitySlices(field, clients);
    expect(versions.length).toBeGreaterThan(1);
    for (const version of versions) {
      const count = probed.filter(({ config }) => {
        const value = field.read(config);
        return Array.isArray(value) && value.includes(version);
      }).length;
      expect(capabilityCoverage(field, clients, version)).toMatchObject({
        full: count,
        probed: probed.length,
        score: Math.round((count / probed.length) * 100),
      });
    }
  });
});
