import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  EvalHeaderActions,
  EvalHeaderActionsSlot,
} from "../eval-header-actions";

describe("EvalHeaderActions", () => {
  it("shows a page's buttons in the breadcrumb bar's slot", () => {
    render(
      <>
        <div className="relative">
          <EvalHeaderActionsSlot />
        </div>
        <main>
          <EvalHeaderActions>
            <button type="button">Save settings</button>
          </EvalHeaderActions>
        </main>
      </>,
    );
    expect(screen.getByTestId("eval-header-actions").textContent).toBe(
      "Save settings",
    );
    expect(screen.getByRole("main").textContent).toBe("");
  });

  it("renders nothing while no bar is mounted", () => {
    render(
      <EvalHeaderActions>
        <button type="button">Save settings</button>
      </EvalHeaderActions>,
    );
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
  });

  it("follows the slot when the bar remounts", () => {
    const actions = (
      <EvalHeaderActions>
        <button type="button">Back to suite</button>
      </EvalHeaderActions>
    );
    const { rerender } = render(
      <>
        <EvalHeaderActionsSlot key="a" />
        {actions}
      </>,
    );
    rerender(
      <>
        <EvalHeaderActionsSlot key="b" />
        {actions}
      </>,
    );
    expect(screen.getByTestId("eval-header-actions").textContent).toBe(
      "Back to suite",
    );
  });
});
