import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HostCapabilitiesOverrideDialog } from "../HostCapabilitiesOverrideDialog";

describe("HostCapabilitiesOverrideDialog", () => {
  it("renders the title without the header description paragraph", () => {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <HostCapabilitiesOverrideDialog
        open
        onOpenChange={onOpenChange}
        hostStyle="claude"
        override={undefined}
        onSave={onSave}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Host capabilities override" }),
    ).toBeInTheDocument();

    expect(
      screen.queryByText(/Advertised in ui\/initialize/i),
    ).not.toBeInTheDocument();

    expect(
      screen.queryByText(/Empty JSON object/),
    ).not.toBeInTheDocument();

    expect(
      screen.queryByText(/Using claude preset/),
    ).not.toBeInTheDocument();

    const clearOverride = screen.getByRole("button", { name: "Clear override" });
    expect(clearOverride).toBeDisabled();
  });

  it("shows override status and enables Clear override when an override is saved", () => {
    render(
      <HostCapabilitiesOverrideDialog
        open
        onOpenChange={vi.fn()}
        hostStyle="claude"
        override={{ serverTools: { listChanged: false } }}
        onSave={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Custom override active"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear override" })).toBeEnabled();
  });

  it("shows a validation error when JSON is invalid", () => {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <HostCapabilitiesOverrideDialog
        open
        onOpenChange={onOpenChange}
        hostStyle="claude"
        override={undefined}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "not-json" },
    });

    expect(
      screen.getByText(/not valid JSON/i),
    ).toBeInTheDocument();
  });
});
