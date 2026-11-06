import { describe, expect, it } from "vitest";
import { isSameSuiteSettingsPage } from "../suite-settings-guard";

const at = (pathname: string, search = "") => ({ pathname, search });
const project = "/p/k57aaaaaaaaaaaaaaaaaaaaaaaaa";

describe("isSameSuiteSettingsPage (I-3)", () => {
  it.each([
    ["/evaluate/suite/s1/settings", "/evaluate/suite/s1/settings/cases"],
    [
      "/evaluate/suite/s1/settings/cases",
      "/evaluate/suite/s1/settings/evaluators",
    ],
    ["/evaluate/suite/s1/settings/evaluators", "/evaluate/suite/s1/settings"],
    [
      `${project}/evaluate/suite/s1/settings`,
      `${project}/evaluate/suite/s1/settings/cases`,
    ],
    [
      `${project}/evaluate/suite/s1/settings`,
      "/evaluate/suite/s1/settings/evaluators",
    ],
  ])("lets %s → %s through", (from, to) => {
    expect(isSameSuiteSettingsPage(at(from), at(to))).toBe(true);
  });

  it("lets a query-only change on the same tab through", () => {
    expect(
      isSameSuiteSettingsPage(
        at("/evaluate/suite/s1/settings/cases", "?importJob=j1"),
        at("/evaluate/suite/s1/settings/cases"),
      ),
    ).toBe(true);
  });

  it.each([
    ["/evaluate/suite/s1/settings", "/evaluate/suite/s2/settings"],
    [
      "/evaluate/suite/s1/settings/cases",
      "/evaluate/suite/s1/settings/cases/c1",
    ],
    [
      "/evaluate/suite/s1/settings/cases",
      "/evaluate/suite/s1/settings/cases/new",
    ],
    ["/evaluate/suite/s1/settings", "/evaluate/suite/s1"],
    ["/evaluate/suite/s1", "/evaluate/suite/s1/settings"],
    ["/evaluate/suite/s1/edit", "/evaluate/suite/s1/edit"],
  ])("prompts for %s → %s", (from, to) => {
    expect(isSameSuiteSettingsPage(at(from), at(to))).toBe(false);
  });
});
