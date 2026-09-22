import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  SCENARIO_DELETE_CONFIRM_PHRASE,
  ScenarioDeleteConfirmDialog,
} from "../ScenarioDeleteConfirmDialog";

describe("ScenarioDeleteConfirmDialog", () => {
  it("does not call onConfirm until the phrase is typed exactly", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <ScenarioDeleteConfirmDialog
        open
        onOpenChange={onOpenChange}
        scenarioName="Prod QA"
        isDeleting={false}
        onConfirm={onConfirm}
      />,
    );

    const confirmButton = screen.getByRole("button", {
      name: "Delete permanently",
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(confirmButton);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(
      screen.getByPlaceholderText(SCENARIO_DELETE_CONFIRM_PHRASE),
      {
        target: { value: "DELETE" },
      },
    );
    expect(confirmButton).toBeDisabled();

    fireEvent.change(
      screen.getByPlaceholderText(SCENARIO_DELETE_CONFIRM_PHRASE),
      {
        target: { value: SCENARIO_DELETE_CONFIRM_PHRASE },
      },
    );
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
