import { describe, expect, it } from "vitest";
import {
  installedVersionMatches,
  newAttempt,
  updateVersion,
} from "../../src/ipc/update/update-attempt.js";

describe("installed version verification", () => {
  it.each([
    ["3.11.0", "3.11.0", true],
    ["3.11.0", "3.12.0", true],
    ["3.11.0", "3.10.1", false],
    ["3.11.0", "3.11.0-beta.1", false],
    ["3.11.0-beta.1", "3.11.0", true],
    ["3.11.0-beta.2", "3.11.0-beta.10", true],
    ["3.11.0-beta.10", "3.11.0-beta.2", false],
    ["3.11.0", "3.11.0+build.2", true],
    [undefined, "3.9.0", false],
    [undefined, "3.10.0+build.2", false],
  ])("target %s, running %s: %s", (target, running, expected) => {
    const attempt = newAttempt("3.10.0");
    attempt.targetVersion = target;
    expect(installedVersionMatches(attempt, running)).toBe(expected);
  });
  it("extracts versions from release names without preserving arbitrary text", () => {
    expect(updateVersion("Release v3.11.0")).toBe("3.11.0");
    expect(updateVersion("private-feed?token=secret")).toBeUndefined();
  });
});
