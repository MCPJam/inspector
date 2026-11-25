import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";
import { describe, expect, it } from "vitest";
import {
  hostConfigField,
  NOT_SUPPORTED,
  type HostComparisonSubject,
} from "@/lib/host-config-field-schema";
import { capabilityCoverage, capabilitySlices } from "../caniuse-coverage";
import { buildPresetCompareEntries } from "../host-compare-presets";

const { subjects } = buildPresetCompareEntries(bundledHostCompatCatalog());
const clients = Object.values(subjects);

describe("caniuse adoption", () => {
  it("distinguishes missing observations from styles measured as absent", () => {
    const field = {
      ...hostConfigField("styles.--color-background-primary"),
      read: (config: HostComparisonSubject["config"]) =>
        config.id === "preset:claude" ? NOT_SUPPORTED : undefined,
    };
    const result = capabilityCoverage(field, [subjects["preset:claude"], subjects["preset:cursor"]]);
    expect(result.rows.map(({ status }) => status)).toEqual(["unsupported", "unknown"]);
    expect(result).toMatchObject({ full: 0, published: 1, measured: 2, score: 0 });
  });

  it("leaves unmeasured CSP subtypes out of the adoption denominator", () => {
    const field = hostConfigField("appsCap.cspConnectDomains.fetch");
    expect(
      capabilityCoverage({ ...field, read: () => undefined }, clients),
    ).toMatchObject({ measured: 0, score: null });
  });

  it("counts inline-only widget rendering for its slice but not for full display-mode support", () => {
    const field = {
      ...hostConfigField("appsCap.availableDisplayModes"),
      read: () => ["inline"],
    };
    expect(capabilityCoverage(field, clients).score).toBe(0);
    expect(capabilityCoverage(field, clients, "inline").score).toBe(100);
  });

  it("omits the MCPJam baseline and untested clients, and keeps partial results in the denominator", () => {
    const sampling = hostConfigField("capabilities.sampling");
    const values = [true, undefined, false, true, true];
    const ids = ["claude", "cursor", "mistral", "chatgpt", "mcpjam"];
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
      ids.map((id) => subjects[`preset:${id}`]),
    );
    expect(coverage).toMatchObject({ full: 2, measured: 4, score: 50 });
    expect(coverage.rows.map(({ status }) => status)).toEqual([
      "supported",
      "partial",
      "unsupported",
      "supported",
    ]);
  });

  it("treats any published Events mode as adoption and measures individual modes independently", () => {
    const field = hostConfigField("eventsDeliveryModes");
    const coverage = capabilityCoverage(field, clients);
    const known = clients.filter(
      ({ hostId, config }) =>
        hostId !== "preset:mcpjam" && Array.isArray(field.read(config)),
    );
    expect(known.length).toBeGreaterThan(0);
    expect(coverage.measured).toBe(known.length);
    const [any, ...modes] = capabilitySlices(field, clients);
    expect(any).toBe("any");
    for (const mode of modes) {
      expect(capabilityCoverage(field, clients, mode).measured).toBe(
        known.length,
      );
    }
  });

  it("computes coverage for every protocol revision from published version lists", () => {
    const field = hostConfigField("supportedProtocolVersions");
    const versions = capabilitySlices(field, clients);
    expect(versions.length).toBeGreaterThan(1);
    const reported = clients.filter(
      ({ hostId, config }) =>
        hostId !== "preset:mcpjam" && Array.isArray(field.read(config)),
    );
    for (const version of versions) {
      const count = reported.filter(({ config }) => {
        const value = field.read(config);
        return Array.isArray(value) && value.includes(version);
      }).length;
      expect(capabilityCoverage(field, clients, version)).toMatchObject({
        full: count,
        measured: reported.length,
        score: Math.round((count / reported.length) * 100),
      });
    }
  });
});
