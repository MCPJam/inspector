import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { DefaultChecksReference } from "../case-workspace/default-checks-reference";
import { CaseChecksPage } from "../case-workspace/case-checks-page";

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
  it("shows the suite checklist immediately and marks and resets case differences", async () => {
    const user = userEvent.setup();
    function Page() {
      const [skipped, setSkipped] = useState(false);
      return (
        <CaseChecksPage
          title="Example"
          disabledChecks={["connection.oauth"]}
          suitePredicates={[]}
          availableTools={[]}
          onPredicatesChange={vi.fn()}
          judgeSkipped={skipped}
          onJudgeSkippedChange={setSkipped}
          onSave={vi.fn()}
          saveDisabled={false}
        />
      );
    }
    render(<Page />);
    expect(
      screen.getByRole("columnheader", { name: "Stage of user value chain" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Show default assertions")).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Successful connection" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "OAuth connection" }),
    ).not.toBeChecked();
    expect(screen.queryByText("Using suite defaults.")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: "Outcome achieved" }),
    );
    expect(screen.getByText("Override")).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: "Outcome achieved" }),
    );
    expect(screen.queryByText("Override")).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Outcome achieved" }),
    ).toBeChecked();
    for (const checkbox of screen.getAllByRole("checkbox"))
      expect(checkbox).toBeEnabled();
    await user.click(
      screen.getByRole("checkbox", { name: "OAuth connection" }),
    );
    expect(screen.getByText("Override")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save overrides" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: "OAuth connection" }),
    );
    expect(
      screen.getByRole("button", { name: "Save overrides" }),
    ).toBeEnabled();
  });
});
