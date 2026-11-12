import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EvalAddDrawer } from "../case-spine/assertion-drawer";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

describe("EvalAddDrawer optional props", () => {
  it("keeps today's heading and label when the props are absent", async () => {
    const user = userEvent.setup();
    render(<EvalAddDrawer onSelect={() => {}} triggerLabel="Add" />);
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Add actions or assertions")).toBeTruthy();
    expect(
      screen.getByText("Choose what happens next or what this test verifies."),
    ).toBeTruthy();
  });

  it("uses the title, description, aria-label and filter it is given", async () => {
    const user = userEvent.setup();
    render(
      <EvalAddDrawer
        onSelect={() => {}}
        triggerLabel="Add assertion"
        ariaLabel="Add assertion after step 2"
        title="Add an assertion"
        description="Graded after step 2."
        filter={(entry) => entry.choice.kind === "widget-check"}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Add assertion after step 2" }),
    );
    expect(screen.getByText("Add an assertion")).toBeTruthy();
    expect(screen.getByText("Graded after step 2.")).toBeTruthy();
    expect(screen.queryByTestId("add-step-item-prompt")).toBeNull();
    expect(screen.getByTestId("add-step-item-widget:textVisible")).toBeTruthy();
  });
});
