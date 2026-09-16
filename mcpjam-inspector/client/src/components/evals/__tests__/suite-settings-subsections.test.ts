import { describe, expect, it } from "vitest";
import {
  getSubsectionsForGroup,
  subsectionForSettingKey,
  subsectionScrollTarget,
  pickActiveSubsectionFromScroll,
} from "../suite-settings-subsections";

describe("getSubsectionsForGroup", () => {
  const base = {
    isVerdictPolicyV2: true,
    showComputerEnvironment: true,
    showSchedule: true,
    showDelete: true,
  };

  it("lists one entry per grading row, in the order the rows render", () => {
    // The rail used to read "Quality gate, Assertions" while the page held the
    // criterion, the count, the gate and the evaluators — three of the four
    // had no jump link, and the one link that existed named the wrong one.
    const subs = getSubsectionsForGroup("grading", base);
    expect(subs.map((sub) => sub.label)).toEqual([
      "Pass criteria",
      "Iterations",
      "Quality gate",
      "Evaluators",
    ]);
    expect(subs.some((sub) => sub.target.type === "stage")).toBe(false);
  });

  it("keeps the same rail whichever criterion decides the suite", () => {
    // The SCOPE changes which control a row shows, never which rows exist: a
    // rail that gained and lost entries would move the jump links under a
    // reader depending on a fact about their suite they did not choose.
    const subs = getSubsectionsForGroup("grading", {
      ...base,
      isVerdictPolicyV2: false,
    });
    expect(subs.map((sub) => sub.label)).toEqual([
      "Pass criteria",
      "Iterations",
      "Quality gate",
      "Evaluators",
    ]);
  });

  it("routes old judge anchors to the stage checks", () => {
    for (const key of ["judge", "judgeRubric", "judgeGroundedness"] as const) {
      expect(subsectionForSettingKey(key, "grading", base)?.id, key).toBe(
        "checks",
      );
    }
  });

  it("labels the checks rail entry with the section's own name", () => {
    // History worth keeping: #5085 renamed the section heading and left the
    // manifest's `checks` row saying "Assertions", so this rail link named one
    // thing and scrolled to another. Nothing caught it, because the rail read
    // the manifest and this test asserted the manifest — the two agreed with
    // each other while both disagreed with the page.
    //
    // Both labels now read "Evaluators", so
    // the manifest is trustworthy here again and the literal below is the
    // section's real heading rather than a second opinion about it.
    const subs = getSubsectionsForGroup("grading", base);
    const checks = subs.find((sub) => sub.target.type === "passOrFailChecks");
    expect(checks?.label).toBe("Evaluators");
  });

  it("routes every grading key to the ONE row that owns it", () => {
    // The partition is the property: each key belongs to exactly one row, so
    // a deep link lands on the heading that actually holds the field. The
    // quality-gate conditions used to route to `policy` — the criterion row —
    // because one row held both, and `validity` needed a hand-written line
    // here to reach the same place.
    const owner: Record<string, string> = {
      minimumAccuracy: "policy",
      passThreshold: "policy",
      validity: "policy",
      minimumIterations: "iterations",
      repetitions: "iterations",
      // The baseline keys are no longer on the page, so they own nothing.
      qualityGateNoGatingScoreErrors: "qualityGate",
    };
    for (const [key, expected] of Object.entries(owner)) {
      expect(
        subsectionForSettingKey(
          key as Parameters<typeof subsectionForSettingKey>[0],
          "grading",
          base,
        )?.id,
        key,
      ).toBe(expected);
    }
  });

  it("maps subsections to scroll anchors and keeps the stage selector", () => {
    const subs = getSubsectionsForGroup("grading", base);
    const policy = subs.find((sub) => sub.id === "policy");
    const checks = subs.find((sub) => sub.id === "checks");
    const judge = subs.find((sub) => sub.id === "judge");
    expect(policy && subsectionScrollTarget(policy)).toBe(
      '[data-subsection-id="policy"]',
    );
    expect(checks && subsectionScrollTarget(checks)).toBe(
      '[data-setting-key="checks"]',
    );
    expect(judge).toBeUndefined();
    expect(
      subsectionScrollTarget({
        id: "stage-selection",
        label: "Selection",
        target: { type: "stage", stage: "selection" },
      }),
    ).toBe('[data-stage-group="selection"]');
  });

  it("picks the last subsection anchor at or above the scroll line", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollTop", { value: 100, writable: true });
    Object.defineProperty(root, "clientHeight", { value: 400 });
    root.getBoundingClientRect = () =>
      ({
        top: 0,
        height: 400,
        bottom: 400,
        left: 0,
        right: 300,
        width: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const policy = document.createElement("div");
    policy.setAttribute("data-subsection-id", "policy");
    policy.getBoundingClientRect = () => ({ top: -80, height: 40 }) as DOMRect;

    const checks = document.createElement("div");
    checks.setAttribute("data-setting-key", "checks");
    checks.getBoundingClientRect = () => ({ top: 40, height: 80 }) as DOMRect;

    root.append(policy, checks);

    const subsections = getSubsectionsForGroup("grading", {
      isVerdictPolicyV2: false,
      showComputerEnvironment: true,
      showSchedule: true,
      showDelete: true,
    }).filter((sub) => sub.id === "policy" || sub.id === "checks");

    expect(pickActiveSubsectionFromScroll(root, subsections)).toBe("checks");
  });
});
