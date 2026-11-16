import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { CaseFieldDependency } from "../case-field-dependency";

describe("CaseFieldDependency", () => {
  it("names the field it reads when no case context is given", () => {
    renderWithProviders(<CaseFieldDependency field="expectedToolCalls" />);
    const chip = screen.getByText("Uses expected tool calls");
    expect(chip).toHaveAttribute("data-tone", "neutral");
  });

  it("counts the suite's cases that leave the field empty", () => {
    renderWithProviders(
      <CaseFieldDependency
        field="expectedToolCalls"
        coverage={{ filled: 9, total: 12 }}
      />,
    );
    const chip = screen.getByText("3 of 12 cases have no expected tool calls");
    expect(chip).toHaveAttribute("data-tone", "missing");
  });

  it("stays neutral when every case fills the field", () => {
    renderWithProviders(
      <CaseFieldDependency
        field="postCondition"
        coverage={{ filled: 4, total: 4 }}
      />,
    );
    expect(screen.getByText("Uses post-condition")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
  });

  it("explains Not applicable on a case that leaves the field empty", () => {
    renderWithProviders(
      <CaseFieldDependency field="postCondition" filled={false} />,
    );
    expect(
      screen.getByText("Not applicable · this case has no post-condition"),
    ).toHaveAttribute("data-tone", "inactive");
  });
});
