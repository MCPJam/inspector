import { describe, expect, it } from "vitest";
import {
  isOlderReportingCli,
  oldRunCliVersion,
} from "../cli-reporting-version";

describe("CLI reporting version", () => {
  it.each(["5.7.1", "6.0.1", "6.3.99", "6.4.0", "6.4.1-rc.1"])(
    "flags %s",
    (version) => {
      expect(isOlderReportingCli(version)).toBe(true);
    },
  );
  it.each([
    undefined,
    null,
    1,
    "",
    "6.4",
    "not a version",
    "6.4.1",
    "6.4.1+build",
    "6.4.10",
    "6.10.0",
    "7.0.0",
    "06.0.0",
    "6.4.0-..",
    "6.4.0-01",
    "6.4.0+..",
  ])("does not flag %s", (version) => {
    expect(isOlderReportingCli(version)).toBe(false);
  });
  it("handles historical CLI-declared action runs and leaves missing metadata unknown", () => {
    expect(
      oldRunCliVersion({
        launcher: {
          kind: "github_action",
          client: "mcpjam-cli",
          version: "5.7.1",
        },
      }),
    ).toBe("5.7.1");
    expect(oldRunCliVersion({})).toBeUndefined();
    expect(
      oldRunCliVersion({
        launcher: { kind: "cli", client: "another-program", version: "1.0.0" },
      }),
    ).toBeUndefined();
    expect(
      oldRunCliVersion({
        launcher: {
          kind: "github_action",
          client: "another-action",
          version: "1.0.0",
        },
      }),
    ).toBeUndefined();
  });
});
