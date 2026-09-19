import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { DefaultChecksReference } from "../case-workspace/default-checks-reference";
import { CaseChecksPage } from "../case-workspace/case-checks-page";
import { STANDARD_ASSERTION_CHECKS } from "@/components/evals/standard-checks-model";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";

describe("Default checks navigation and page", () => {
  it("opens the checks page directly", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(<DefaultChecksReference onOverride={navigate} />);
    await user.click(
      screen.getByRole("button", { name: "Configure test case evaluators" }),
    );
    expect(navigate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("renders real standard checks, toggles the judge, and authors a case rule", async () => {
    const user = userEvent.setup();
    const onChecksChange = vi.fn();
    const capabilities = {
      scorers: {
        predicateKinds: STANDARD_ASSERTION_CHECKS.map((c) => c.preset.type),
        suppressedSuiteStandardCheckIds: true,
      },
    } as SuiteCapabilities;
    function Page() {
      const [skipped, setSkipped] = useState(false);
      return (
        <CaseChecksPage
          title="Example"
          suitePredicates={[]}
          capabilities={capabilities}
          onChecksChange={onChecksChange}
          judgeSkipped={skipped}
          onJudgeSkippedChange={setSkipped}
        />
      );
    }
    const { container } = render(<Page />);
    // The same numbered table the suite settings page renders.
    expect(
      screen.getByRole("heading", { name: "Test Case Evaluators" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Configure test case evaluators"),
    ).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-stage-group]").length).toBe(6);
    // Runner-measured stages are rows without an On box: nothing to author.
    for (const stage of ["connection", "discovery"]) {
      const observed = container.querySelector(
        `[data-stage-group="${stage}"] [data-scorer-row="observed"]`,
      );
      expect(observed?.textContent, stage).toContain("Required");
      expect(
        observed?.querySelector('[role="checkbox"]'),
        stage,
      ).toBeDisabled();
    }
    expect(
      screen.queryByRole("checkbox", { name: "OAuth connection" }),
    ).not.toBeInTheDocument();
    // The suite's editors stay on the suite page.
    expect(screen.queryByText("Edit tool-call matching")).toBeNull();
    expect(screen.queryByText("Template v3")).toBeNull();
    // The judge row is the case's judge-skipped flag, both directions.
    const outcome = () =>
      screen.getByRole("checkbox", { name: "Goal completion judge" });
    expect(outcome()).toBeChecked();
    await user.click(outcome());
    expect(outcome()).not.toBeChecked();
    await user.click(outcome());
    expect(outcome()).toBeChecked();
    // An assertion row that is off authors the preset as a case rule.
    const latency = STANDARD_ASSERTION_CHECKS.find(
      (c) => c.id === "response.performance",
    )!;
    expect(
      screen.getByRole("checkbox", { name: latency.name }),
    ).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: latency.name }));
    expect(onChecksChange).toHaveBeenCalledWith({
      predicates: { mode: "extend", list: [latency.preset] },
      suppressedSuiteStandardCheckIds: [],
    });
    // Changes persist through the change callbacks; navigation uses breadcrumbs.
    expect(
      screen.queryByRole("button", { name: "Save overrides" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Back to case" }),
    ).not.toBeInTheDocument();
  });
});
