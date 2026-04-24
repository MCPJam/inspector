import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ElicitationDialog } from "../ElicitationDialog";
import type { DialogElicitation } from "../ToolsTab";

vi.mock("@mcpjam/design-system/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        <button
          data-testid="dialog-x-button"
          onClick={() => onOpenChange(false)}
        />
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@mcpjam/design-system/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const makeRequest = (overrides?: Partial<DialogElicitation>): DialogElicitation => ({
  requestId: "req-1",
  message: "Please provide your name",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Your name" },
    },
    required: ["name"],
  },
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe("ElicitationDialog", () => {
  it("does not render when elicitationRequest is null", () => {
    const onResponse = vi.fn();
    render(<ElicitationDialog elicitationRequest={null} onResponse={onResponse} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders when elicitationRequest is set", () => {
    const onResponse = vi.fn();
    render(
      <ElicitationDialog
        elicitationRequest={makeRequest()}
        onResponse={onResponse}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Please provide your name")).toBeInTheDocument();
  });

  it("calls onResponse with cancel when Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onResponse = vi.fn().mockResolvedValue(undefined);
    render(
      <ElicitationDialog
        elicitationRequest={makeRequest()}
        onResponse={onResponse}
      />,
    );
    await user.click(screen.getByText("Cancel"));
    expect(onResponse).toHaveBeenCalledWith("cancel");
  });

  it("calls onResponse with cancel when the X button closes the dialog", async () => {
    const user = userEvent.setup();
    const onResponse = vi.fn().mockResolvedValue(undefined);
    render(
      <ElicitationDialog
        elicitationRequest={makeRequest()}
        onResponse={onResponse}
      />,
    );
    await user.click(screen.getByTestId("dialog-x-button"));
    expect(onResponse).toHaveBeenCalledWith("cancel");
  });
});
