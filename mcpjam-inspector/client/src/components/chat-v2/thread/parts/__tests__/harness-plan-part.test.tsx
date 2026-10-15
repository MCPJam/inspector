import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HarnessPlanPart } from "../harness-plan-part";

describe("HarnessPlanPart", () => {
  it("shows the plan as a checklist with its progress", () => {
    render(
      <HarnessPlanPart
        plan={{
          explanation: "Fix the login bug",
          steps: [
            { step: "Read the code", status: "completed" },
            { step: "Write the fix", status: "inProgress" },
            { step: "Run the tests", status: "pending" },
          ],
        }}
      />,
    );
    expect(screen.getByText("1 of 3 done")).toBeInTheDocument();
    expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
    expect(screen.getByLabelText("Done")).toBeInTheDocument();
    expect(screen.getByLabelText("In progress")).toBeInTheDocument();
    expect(screen.getByLabelText("To do")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("data-status")),
    ).toEqual(["completed", "inProgress", "pending"]);
  });

  it("an empty plan renders nothing", () => {
    const { container } = render(<HarnessPlanPart plan={{ steps: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
