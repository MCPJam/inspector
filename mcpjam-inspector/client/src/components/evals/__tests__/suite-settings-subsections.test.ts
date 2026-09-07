import { describe, expect, it } from "vitest";
import { USER_VALUE_STAGE_LABELS } from "@mcpjam/sdk/contract";
import {
  getSubsectionsForGroup,
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

  it("lists chain stages under grading after policy and validity", () => {
    const subs = getSubsectionsForGroup("grading", base);
    const labels = subs.map((sub) => sub.label);
    expect(labels.slice(0, 2)).toEqual(["Policy", "Validity"]);
    expect(labels).toContain(USER_VALUE_STAGE_LABELS.userValue);
    expect(labels.at(-1)).toBe("Checks");
  });

  it("omits validity on legacy policy suites", () => {
    const subs = getSubsectionsForGroup("grading", {
      ...base,
      isVerdictPolicyV2: false,
    });
    expect(subs.map((sub) => sub.label)).not.toContain("Validity");
  });

  it("maps subsections to scroll anchors", () => {
    const subs = getSubsectionsForGroup("grading", base);
    const policy = subs.find((sub) => sub.id === "policy");
    const selection = subs.find((sub) => sub.id === "stage-selection");
    const checks = subs.find((sub) => sub.id === "checks");
    expect(policy && subsectionScrollTarget(policy)).toBe(
      '[data-subsection-id="policy"]',
    );
    expect(selection && subsectionScrollTarget(selection)).toBe(
      '[data-stage-group="selection"]',
    );
    expect(checks && subsectionScrollTarget(checks)).toBe(
      '[data-setting-key="checks"]',
    );
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
    policy.getBoundingClientRect = () =>
      ({ top: -80, height: 40 } as DOMRect);

    const checks = document.createElement("div");
    checks.setAttribute("data-setting-key", "checks");
    checks.getBoundingClientRect = () =>
      ({ top: 40, height: 80 } as DOMRect);

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
