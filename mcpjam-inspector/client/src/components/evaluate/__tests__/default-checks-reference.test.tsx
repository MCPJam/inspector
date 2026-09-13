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
      screen.getByRole("button", { name: "Show default assertions" }),
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
          onSave={vi.fn()}
          saveDisabled={false}
        />
      );
    }
    render(<Page />);
    expect(
      screen.getByRole("heading", { name: "Checks by stage" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Show default assertions"),
    ).not.toBeInTheDocument();
    // Runner-measured stages are rows, not toggles: nothing to author there.
    expect(
      screen.getByText(/Connection — measured by the runner/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Tool discovery — measured by the runner/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "OAuth connection" }),
    ).not.toBeInTheDocument();
    // The judge row is the case's judge-skipped flag, both directions.
    const outcome = () =>
      screen.getByRole("checkbox", { name: "Outcome achieved" });
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
      screen.getByRole("checkbox", { name: latency.label }),
    ).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: latency.label }));
    expect(onChecksChange).toHaveBeenCalledWith({
      predicates: { mode: "extend", list: [latency.preset] },
      suppressedSuiteStandardCheckIds: [],
    });
    // The save path is the case's own; the page never blocks it on a preview.
    expect(
      screen.getByRole("button", { name: "Save overrides" }),
    ).toBeEnabled();
  });
});
