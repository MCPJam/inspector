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

  it("lists quality gate and the scorers table", () => {
    const subs = getSubsectionsForGroup("grading", base);
    expect(subs.map((sub) => sub.label)).toEqual([
      "Quality gate",
      "Scorers",
    ]);
    expect(subs.some((sub) => sub.target.type === "stage")).toBe(false);
  });

  it("keeps the same rail on a legacy suite", () => {
    const subs = getSubsectionsForGroup("grading", {
      ...base,
      isVerdictPolicyV2: false,
    });
    expect(subs.map((sub) => sub.label)).toEqual([
      "Quality gate",
      "Scorers",
    ]);
  });

  it("routes old judge anchors to the stage checks", () => {
    for (const key of ["judge", "judgeRubric", "judgeGroundedness"] as const) {
      expect(subsectionForSettingKey(key, "grading", base)?.id, key).toBe(
        "checks",
      );
    }
  });

  it("routes quality-gate and nested validity keys to the policy subsection", () => {
    for (const key of [
      "validity",
      "qualityGateBaseline",
      "qualityGateAllowedDrop",
      "qualityGateNoDeterministicRegressions",
      "qualityGateMaximumP95LatencyIncreaseMs",
      "qualityGateNoGatingScoreErrors",
    ] as const) {
      expect(subsectionForSettingKey(key, "grading", base)?.id, key).toBe(
        "policy",
      );
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
