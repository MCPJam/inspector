import { describe, expect, it } from "vitest";
import { staysInSuiteSettings } from "../use-suite-settings-nav";
import { suiteSettingsTabRowsClass } from "../suite-settings-tabs";

const SETTINGS = "/evaluate/suite/s1/settings";
const IN_PROJECT = `/p/jd7abc123def456ghi789jkl012mno34${SETTINGS}`;

describe("staysInSuiteSettings", () => {
  it.each([
    [SETTINGS, `${SETTINGS}/evaluators`, true],
    [`${SETTINGS}/cases`, SETTINGS, true],
    [`${IN_PROJECT}/evaluators`, IN_PROJECT, true],
    // Opening a case leaves the page, so an unsaved draft still asks first.
    [`${SETTINGS}/cases`, `${SETTINGS}/cases/c1`, false],
    [SETTINGS, "/evaluate/suite/s1", false],
    [SETTINGS, "/evaluate/suite/s2/settings", false],
    ["/evaluate/suite/s1/edit", SETTINGS, false],
  ])("%s → %s: %s", (from, to, expected) => {
    expect(staysInSuiteSettings(from, to)).toBe(expected);
  });
});

describe("suiteSettingsTabRowsClass", () => {
  it("hides the other tab's rows and nothing without a tab", () => {
    expect(suiteSettingsTabRowsClass("settings")).toContain("passOrFail");
    expect(suiteSettingsTabRowsClass("evaluators")).toContain(":not(");
    expect(suiteSettingsTabRowsClass(null)).toBe("");
  });
});
