/**
 * The client half of the clustering tuning contract.
 *
 * Two things here are load-bearing beyond ordinary helper coverage:
 *
 *   - Balanced must equal the defaults exactly. Every scope inherits its tuning
 *     from its last completed run, so a drift between "Balanced" and "untuned"
 *     would re-theme every chatbox that had never been tuned.
 *   - The ranges are re-validated server-side. A slider that can reach a value
 *     the mutation rejects turns a knob into an error toast.
 */
import { describe, expect, it } from "vitest";
import {
  CLUSTER_TUNING_DEFAULTS,
  CLUSTER_TUNING_PRESETS,
  CLUSTER_TUNING_RANGES,
  formatKnobValue,
  pickKnobs,
  presetFor,
  resolveClusterTuning,
} from "@/lib/cluster-tuning";

describe("cluster tuning presets", () => {
  it("Balanced is exactly the defaults", () => {
    expect(CLUSTER_TUNING_PRESETS.balanced).toEqual(CLUSTER_TUNING_DEFAULTS);
  });

  it("every preset value sits inside the range the server accepts", () => {
    for (const preset of Object.values(CLUSTER_TUNING_PRESETS)) {
      for (const [knob, value] of Object.entries(preset)) {
        const range =
          CLUSTER_TUNING_RANGES[knob as keyof typeof CLUSTER_TUNING_RANGES];
        expect(value).toBeGreaterThanOrEqual(range.min);
        expect(value).toBeLessThanOrEqual(range.max);
      }
    }
  });

  it("orders Broad → Balanced → Detailed monotonically on every knob", () => {
    const { broad, balanced, detailed } = CLUSTER_TUNING_PRESETS;
    // More themes allowed, and a lower bar to split, as you move to Detailed.
    expect(broad.maxClusters).toBeLessThan(balanced.maxClusters);
    expect(balanced.maxClusters).toBeLessThan(detailed.maxClusters);
    expect(broad.minSeparation).toBeGreaterThan(balanced.minSeparation);
    expect(balanced.minSeparation).toBeGreaterThan(detailed.minSeparation);
    // A lower link threshold connects more of the map, which is what "broad"
    // looks like there — so this knob runs the other way on purpose.
    expect(broad.linkThreshold).toBeLessThan(balanced.linkThreshold);
    expect(balanced.linkThreshold).toBeLessThan(detailed.linkThreshold);
  });
});

describe("resolveClusterTuning", () => {
  it("fills absent knobs from the defaults", () => {
    expect(resolveClusterTuning(undefined)).toEqual(CLUSTER_TUNING_DEFAULTS);
    expect(resolveClusterTuning({ maxClusters: 4 })).toEqual({
      ...CLUSTER_TUNING_DEFAULTS,
      maxClusters: 4,
    });
  });
});

describe("presetFor", () => {
  it("names an exact preset and returns null for anything else", () => {
    expect(presetFor(CLUSTER_TUNING_PRESETS.broad)).toBe("broad");
    expect(presetFor(undefined)).toBe("balanced");
    expect(presetFor({ ...CLUSTER_TUNING_PRESETS.broad, maxClusters: 5 })).toBe(
      null,
    );
  });

  it("ignores knobs the caller excludes from the comparison", () => {
    // Surfaces that hide a knob can pass a subset so a partial match still
    // lights the matching preset.
    const twoKnobs = ["maxClusters", "minSeparation"] as const;
    const tuning = {
      maxClusters: CLUSTER_TUNING_PRESETS.broad.maxClusters,
      minSeparation: CLUSTER_TUNING_PRESETS.broad.minSeparation,
      linkThreshold: 0.91,
    };
    expect(presetFor(tuning)).toBe(null);
    expect(presetFor(tuning, [...twoKnobs])).toBe("broad");
  });
});

describe("pickKnobs", () => {
  it("emits only the knobs the scope owns", () => {
    expect(
      pickKnobs(CLUSTER_TUNING_DEFAULTS, ["maxClusters", "minSeparation"]),
    ).toEqual({
      maxClusters: CLUSTER_TUNING_DEFAULTS.maxClusters,
      minSeparation: CLUSTER_TUNING_DEFAULTS.minSeparation,
    });
  });
});

describe("formatKnobValue", () => {
  it("shows counts bare and ratios to two decimals", () => {
    expect(formatKnobValue("maxClusters", 8)).toBe("8");
    expect(formatKnobValue("minSeparation", 0.1)).toBe("0.10");
    expect(formatKnobValue("linkThreshold", 0.8)).toBe("0.80");
  });
});
