import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClientCapabilitiesOverrideDialog } from "../ClientCapabilitiesOverrideDialog";

describe("ClientCapabilitiesOverrideDialog", () => {
  it("renders the title without the header description paragraph", () => {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <ClientCapabilitiesOverrideDialog
        open
        onOpenChange={onOpenChange}
        hostStyle="claude"
        override={undefined}
        onSave={onSave}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Client capabilities override" }),
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
      <ClientCapabilitiesOverrideDialog
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

  it.each(["[]", "null", "42"])("explains the required object shape for %s", (value) => {
    render(<ClientCapabilitiesOverrideDialog open onOpenChange={vi.fn()} hostStyle="claude" override={undefined} onSave={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value } });
    expect(screen.getByText('Enter a JSON object enclosed in { }, such as {"key": "value"}.')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows a validation error when JSON is invalid", () => {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <ClientCapabilitiesOverrideDialog
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
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: '{"serverTools": {}}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ serverTools: {} });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
