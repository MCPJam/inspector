import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuiteSwitcher } from "../suite-switcher";

function makeEntry(suiteId: string, name: string) {
  return {
    suite: {
      _id: suiteId,
      createdBy: "user-1",
      name,
      description: "",
      configRevision: "rev-1",
      environment: { servers: ["server-a"] },
      createdAt: 1,
      updatedAt: 1,
      source: "ui" as const,
      tags: [],
    },
    latestRun: null,
    recentRuns: [],
    passRateTrend: [],
    totals: { passed: 1, failed: 0, runs: 1 },
  };
}

describe("SuiteSwitcher", () => {
  it("opens the suite picker from the Suites trigger", async () => {
    const user = userEvent.setup();
    render(
      <SuiteSwitcher
        suites={[makeEntry("suite-a", "amazon"), makeEntry("suite-b", "other")]}
        currentSuiteId="suite-a"
        onSelectSuite={vi.fn()}
        onCreateSuite={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: /Switch suite \(current: amazon\)/,
      }),
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /other/ })).toBeInTheDocument();
  });

  it("selects another suite from the picker", async () => {
    const user = userEvent.setup();
    const onSelectSuite = vi.fn();

    render(
      <SuiteSwitcher
        suites={[makeEntry("suite-a", "amazon"), makeEntry("suite-b", "other")]}
        currentSuiteId="suite-a"
        onSelectSuite={onSelectSuite}
        onCreateSuite={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: /Switch suite \(current: amazon\)/,
      }),
    );
    await user.click(screen.getByRole("button", { name: /other/ }));

    expect(onSelectSuite).toHaveBeenCalledWith("suite-b");
  });
});
