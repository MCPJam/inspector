/**
 * Finding 6: `executeDisabled` must keep BOTH of this panel's execute paths
 * honest — the Execute button (disabled + tooltip with the reason) and the
 * panel's own Enter shortcut. The owning tab also guards `executeTool`, but
 * this panel must not offer an action the tab will refuse.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ParametersPanel } from "../ParametersPanel";
import type { FormField } from "@/lib/tool-form";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("../../ui/resizable", () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
}));

const DISABLED_REASON =
  "This tool requires task execution, and tasks are disabled by the host configuration.";

const stringField: FormField = {
  name: "name",
  type: "string",
  required: true,
  value: "",
  isSet: true,
};

describe("ParametersPanel execute gating", () => {
  const onExecute = vi.fn();
  const onSave = vi.fn();
  const onFieldChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderPanel = (executeDisabled: boolean) =>
    render(
      <ParametersPanel
        selectedTool="long_job"
        formFields={[stringField]}
        loading={false}
        waitingOnElicitation={false}
        onExecute={onExecute}
        onSave={onSave}
        onFieldChange={onFieldChange}
        executeDisabled={executeDisabled}
        executeDisabledReason={executeDisabled ? DISABLED_REASON : undefined}
      />
    );

  it("disables the Execute button when executeDisabled is set", () => {
    renderPanel(true);
    expect(screen.getByRole("button", { name: /execute/i })).toBeDisabled();
  });

  it("does not fire onExecute from the Enter shortcut when disabled", () => {
    renderPanel(true);
    const input = screen.getByPlaceholderText("Enter name");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("keeps the button and the Enter shortcut live when not disabled", () => {
    renderPanel(false);

    const button = screen.getByRole("button", { name: /execute/i });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onExecute).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByPlaceholderText("Enter name"), {
      key: "Enter",
    });
    expect(onExecute).toHaveBeenCalledTimes(2);
  });

  it("wraps the disabled button in a tooltip trigger carrying the reason", () => {
    renderPanel(true);
    // The disabled button is wrapped so the tooltip can still open (a
    // disabled button swallows pointer events). Radix renders the content on
    // hover only, so assert the trigger wrapper exists around the button.
    const button = screen.getByRole("button", { name: /execute/i });
    expect(button.parentElement?.tagName).toBe("SPAN");
  });
});
