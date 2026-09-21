/**
 * What a scenario deletion actually removed, said accurately.
 *
 * The string this replaces asserted "the environment behind the scenario is
 * left untouched" unconditionally, and kept saying it after that stopped being
 * true. So the cases that matter here are the ones where the outcomes differ —
 * and the compatibility case, where saying the old thing is once again right.
 */
import { describe, expect, it } from "vitest";
import { describeScenarioDeletion } from "../scenario-backing";

const BASE = "The scenario and its history are gone.";

describe("describeScenarioDeletion", () => {
  it("says nothing about a setup for a host-backed scenario (no environment)", () => {
    expect(describeScenarioDeletion(null)).toBe(BASE);
    expect(describeScenarioDeletion(undefined)).toBe(BASE);
    expect(
      describeScenarioDeletion(null, {
        environmentArchived: false,
        hostDeleted: false,
      }),
    ).toBe(BASE);
  });

  it("reports the full retirement when the scenario owned its backing", () => {
    const note = describeScenarioDeletion("env-1", {
      environmentArchived: true,
      hostDeleted: true,
    });
    expect(note).toContain(BASE);
    expect(note).toMatch(/setup and the private client behind it were removed/i);
    expect(note).not.toMatch(/unchanged/i);
  });

  it("reports a kept client, with the backend's reason", () => {
    const note = describeScenarioDeletion("env-1", {
      environmentArchived: true,
      hostDeleted: false,
      keptReason: "2 eval suite reference(s) still point at it.",
    });
    expect(note).toMatch(/setup was archived/i);
    expect(note).toContain("2 eval suite reference(s) still point at it.");
  });

  it("still reads as a sentence when a kept client carries no reason", () => {
    const note = describeScenarioDeletion("env-1", {
      environmentArchived: true,
      hostDeleted: false,
    });
    expect(note).toMatch(/client behind it was kept\.$/);
  });

  it("says the environment is unchanged when nothing was retired", () => {
    expect(
      describeScenarioDeletion("env-1", {
        environmentArchived: false,
        hostDeleted: false,
        keptReason: "The setup behind this scenario is a saved environment.",
      }),
    ).toMatch(/environment it was published from is unchanged/i);
  });

  it("falls back to the unchanged wording when the backend sends no report", () => {
    // A frontend ahead of its backend. The old deployment has no retirement
    // path at all, so "unchanged" is the accurate statement, not a hedge.
    expect(describeScenarioDeletion("env-1")).toMatch(
      /environment it was published from is unchanged/i,
    );
  });
});
