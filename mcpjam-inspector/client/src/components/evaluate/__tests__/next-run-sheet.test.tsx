import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRunSheet } from "../case-workspace/next-run-sheet";

describe("NextRunSheet", () => {
  it("renders the two groups and writes host and trials", async () => {
    const user = userEvent.setup();
    const onTrialsChange = vi.fn();
    const onHostChange = vi.fn();
    const onModelChange = vi.fn();
    render(
      <NextRunSheet
        open
        onOpenChange={vi.fn()}
        trials={1}
        onTrialsChange={onTrialsChange}
        hostValue="host-a"
        hostOptions={[
          { value: "host-a", label: "Claude" },
          { value: "host-b", label: "ChatGPT" },
        ]}
        onHostChange={onHostChange}
        modelValue="m1"
        modelOptions={[
          { value: "m1", label: "Haiku" },
          { value: "m2", label: "Sonnet" },
        ]}
        onModelChange={onModelChange}
      />,
    );
    // Trials and Model are persisted on the case before every quick run and
    // on Save; only the host is a per-run choice. The grouping must say so.
    const saved = within(screen.getByTestId("next-run-saved-group"));
    const perRun = within(screen.getByTestId("next-run-for-this-run"));
    expect(saved.getByText("Saved with this case")).toBeInTheDocument();
    expect(saved.getByLabelText("Trials")).toBeInTheDocument();
    expect(saved.getByLabelText("Model")).toBeInTheDocument();
    expect(perRun.getByText("For this run")).toBeInTheDocument();
    expect(perRun.getByLabelText("Host")).toBeInTheDocument();
    expect(perRun.queryByLabelText("Model")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Trials"), "3");
    expect(onTrialsChange).toHaveBeenCalledWith(3);
    await user.selectOptions(screen.getByLabelText("Host"), "host-b");
    expect(onHostChange).toHaveBeenCalledWith("host-b");
    await user.selectOptions(screen.getByLabelText("Model"), "m2");
    expect(onModelChange).toHaveBeenCalledWith("m2");
  });
});
