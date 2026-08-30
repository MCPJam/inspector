/**
 * Version-pin validation on the environment operations' input schema.
 *
 * The pins are only meaningful RELATIVE to the selection they ride on, and both
 * ways of getting that relation wrong are silent rather than loud: a duplicate
 * pin makes "which revision does this skill run?" ambiguous, and a pin naming an
 * unselected skill simply does nothing. The API rejects both; catching them here
 * turns a round-trip error into an immediate one.
 */
import { describe, expect, it } from "vitest";
import { createEnvironmentOperation } from "../../src/platform/index.js";

const BASE = {
  name: "Baseline",
  hostId: "host-1",
};

function parse(skillSelection: unknown) {
  return createEnvironmentOperation.inputSchema.safeParse({
    ...BASE,
    skillSelection,
  });
}

describe("environment skillSelection version pins", () => {
  it("accepts a selection with no pins — every skill runs Latest", () => {
    expect(parse({ mode: "explicit", skillIds: ["skill-a"] }).success).toBe(
      true
    );
  });

  it("accepts one pin per selected skill", () => {
    const result = parse({
      mode: "explicit",
      skillIds: ["skill-a", "skill-b"],
      versionPins: [
        { skillId: "skill-a", versionId: "ver-1" },
        { skillId: "skill-b", versionId: "ver-7" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects two pins for the same skill", () => {
    const result = parse({
      mode: "explicit",
      skillIds: ["skill-a"],
      versionPins: [
        { skillId: "skill-a", versionId: "ver-1" },
        { skillId: "skill-a", versionId: "ver-2" },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(
      /more than one version pin/
    );
  });

  it("rejects a pin for a skill the environment does not select", () => {
    const result = parse({
      mode: "explicit",
      skillIds: ["skill-a"],
      versionPins: [{ skillId: "skill-b", versionId: "ver-1" }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/not in skillIds/);
  });
});
