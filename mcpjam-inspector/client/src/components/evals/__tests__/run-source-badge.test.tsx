import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunSourceBadge } from "../run-source-badge";

describe("RunSourceBadge", () => {
  it("labels every value of the run source union", () => {
    // `testSuiteRun.source` has five values; a badge that only understood
    // ui/sdk would render the other three as the default and quietly
    // mislabel scheduled and GitHub-check runs as app-launched.
    const cases: Array<
      [Parameters<typeof RunSourceBadge>[0]["source"], string]
    > = [
      ["ui", "UI"],
      ["sdk", "SDK"],
      ["api", "API"],
      ["schedule", "Scheduled"],
      ["github_check", "GitHub"],
    ];

    for (const [source, label] of cases) {
      const { unmount } = render(<RunSourceBadge source={source} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it("treats a legacy run with no source as UI", () => {
    // Rows predating the field. Same fallback `getRunMetricSource` uses.
    render(<RunSourceBadge source={undefined} />);
    expect(screen.getByText("UI")).toBeTruthy();
  });

  it("carries an explanatory title for each origin", () => {
    render(<RunSourceBadge source="github_check" />);
    expect(screen.getByTitle(/GitHub pull-request check/i)).toBeTruthy();
  });
});
