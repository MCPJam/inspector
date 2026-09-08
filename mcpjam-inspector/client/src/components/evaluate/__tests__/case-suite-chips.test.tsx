import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CaseSuiteChips } from "../simple-case/case-suite-chips";

describe("CaseSuiteChips", () => {
  it("renders model labels, not raw values", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <CaseSuiteChips
        models={["anthropic/claude-haiku-4.5"]}
        modelLabelByValue={{ "anthropic/claude-haiku-4.5": "Haiku 4.5" }}
        trials={3}
        hostLabel="Claude"
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("Haiku 4.5")).toBeInTheDocument();
    expect(
      screen.queryByText("anthropic/claude-haiku-4.5"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Model/ }));
    expect(onOpen).toHaveBeenCalled();
  });
});
