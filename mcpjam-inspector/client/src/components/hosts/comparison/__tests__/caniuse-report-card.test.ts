import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostConfigField } from "@/lib/host-config-field-schema";
import {
  capabilityCoverage,
  type CapabilityCoverage,
} from "../caniuse-coverage";
import { drawCaniuseReportCard } from "../caniuse-report-card";
import { buildPresetCompareEntries } from "../host-compare-presets";

const { subjects } = buildPresetCompareEntries(bundledHostCompatCatalog());
const clients = Object.values(subjects);
const events = hostConfigField("eventsDeliveryModes");
const needsFonts = !("fonts" in document);

beforeEach(() => {
  if (needsFonts) {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
});

afterEach(() => {
  if (needsFonts) Reflect.deleteProperty(document, "fonts");
});

async function cardText(coverage: CapabilityCoverage) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const fillText = vi.fn<(text: string) => void>();
  ctx.fillText = fillText;
  await drawCaniuseReportCard(
    canvas,
    "MCP Events",
    "Any mode",
    coverage,
    new AbortController().signal,
  );
  return fillText.mock.calls.map(([text]) => text);
}

describe("caniuse report card", () => {
  it("prints the numerator and all probed clients alongside the score", async () => {
    const coverage = capabilityCoverage(events, clients);
    expect(coverage.probed).toBeGreaterThan(coverage.published);
    const labels = await cardText(coverage);
    expect(labels).toEqual(
      expect.arrayContaining([
        `${coverage.score}%`,
        `${coverage.full} of ${coverage.probed} probed clients`,
        `${coverage.probed - coverage.published} without a published result`,
      ]),
    );
  });

  it("prints the site name once, before the capability title", async () => {
    const labels = await cardText(capabilityCoverage(events, clients));
    expect(labels[0]).toBe("caniuse.dev");
    expect(labels.filter((label) => label.includes("caniuse.dev"))).toEqual([
      "caniuse.dev",
    ]);
  });

  it("keeps an unmeasured capability distinct from measured zero support", async () => {
    const unknown = capabilityCoverage(
      { ...events, read: () => undefined },
      clients,
    );
    const measured = capabilityCoverage({ ...events, read: () => [] }, clients);
    const ratio = `0 of ${unknown.probed} probed clients`;
    const unmeasuredText = await cardText(unknown);
    expect(unmeasuredText).toContain("No published client results yet.");
    expect(unmeasuredText).not.toContain(ratio);
    expect(await cardText(measured)).toEqual(
      expect.arrayContaining(["0%", ratio]),
    );
  });
});
