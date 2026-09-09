import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DescribeCaseWorkspace } from "../describe-case-workspace";

describe("DescribeCaseWorkspace", () => {
  it("opens the shared agent instead of mounting a second composer", () => {
    const onAsk = vi.fn();
    const onTitleChange = vi.fn();
    render(
      <DescribeCaseWorkspace
        title="Untitled test case"
        onTitleChange={onTitleChange}
        caseForm={<div>Case steps</div>}
        onAsk={onAsk}
        onSave={vi.fn()}
        saveDisabled
      />,
    );
    expect(screen.getByText("Case steps")).toBeVisible();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Describe the behavior to test" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask MCPJam" }));
    expect(onAsk).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Draft case title"), {
      target: { value: "Refund policy" },
    });
    expect(onTitleChange).toHaveBeenCalledWith("Refund policy");
    expect(screen.getByRole("button", { name: "Save case" })).toBeDisabled();
  });
});
