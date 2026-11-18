import { describe, expect, it } from "vitest";
import { overviewCapabilities } from "../overview-capabilities";
import { deriveServerFeatureEvidence } from "../use-server-feature-evidence";
import { storedEvidence } from "./fixtures";

function evidenceFor(
  data: Parameters<typeof deriveServerFeatureEvidence>[0],
  status: "loading" | "ready" | "error" = "ready",
) {
  return {
    ...deriveServerFeatureEvidence(data, { connected: true }),
    status,
  };
}

describe("overviewCapabilities", () => {
  it("lists the capabilities the evaluator calls Supported", () => {
    // The fixture declares tools and resources; prompts are a Could add.
    const data = { ...storedEvidence(), latestConformanceRun: null };
    expect(overviewCapabilities(evidenceFor(data))).toEqual([
      "Tools",
      "Resources",
    ]);
  });

  it("leaves Overview its own list until saved evidence holds a capture", () => {
    expect(overviewCapabilities(evidenceFor(undefined, "loading"))).toBe(
      undefined,
    );
    expect(overviewCapabilities(evidenceFor(undefined, "error"))).toBe(
      undefined,
    );
    const nothingCaptured = {
      inspection: null,
      probeResults: [],
      observations: [],
      latestConformanceRun: null,
    };
    expect(overviewCapabilities(evidenceFor(nothingCaptured))).toBe(undefined);
  });
});
