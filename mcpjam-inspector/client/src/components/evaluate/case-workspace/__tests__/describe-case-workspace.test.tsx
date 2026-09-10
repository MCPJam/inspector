import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { DescribeCaseWorkspace } from "../describe-case-workspace";

describe("DescribeCaseWorkspace", () => {
  beforeEach(() => useAgentPanelStore.setState({ isOpen: false }));
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
    expect(screen.queryByText("Draft", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Every field is editable")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask MCPJam" })).toHaveClass("absolute", "bottom-5", "right-5");
    fireEvent.click(screen.getByRole("button", { name: "Ask MCPJam" }));
    expect(onAsk).toHaveBeenCalledOnce();
    act(() => useAgentPanelStore.getState().setOpen(true));
    expect(screen.queryByRole("button", { name: "Ask MCPJam" })).not.toBeInTheDocument();
    act(() => useAgentPanelStore.getState().setOpen(false));
    expect(screen.getByRole("button", { name: "Ask MCPJam" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Draft case title"), {
      target: { value: "Refund policy" },
    });
    expect(onTitleChange).toHaveBeenCalledWith("Refund policy");
    expect(screen.getByRole("button", { name: "Save case" })).toBeDisabled();
  });
});
