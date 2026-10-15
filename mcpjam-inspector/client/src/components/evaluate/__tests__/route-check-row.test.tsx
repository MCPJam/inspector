import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouteCheckRow } from "../case-spine/route-check-row";

const mount = () => {
  const callbacks = {
    onRemove: vi.fn(),
    onAddTool: vi.fn(),
    onToolChange: vi.fn(),
    onToolRemove: vi.fn(),
    onReorder: vi.fn(),
  };
  render(
    <ul>
      <RouteCheckRow
        kind="exactOrder"
        newest={false}
        tools={[
          { id: "first", toolName: "list_services", arguments: {} },
          { id: "second", toolName: "get_service", arguments: {} },
        ]}
        {...callbacks}
      />
    </ul>,
  );
  return callbacks;
};

describe("Paper exact tool order fields", () => {
  it("uses named fields and keeps tool editing, adding, and removal available", async () => {
    const user = userEvent.setup();
    const callbacks = mount();
    expect(screen.getByText("First tool")).toBeVisible();
    expect(screen.getByText("Second tool")).toBeVisible();
    expect(screen.getByLabelText("Expected tool 1")).toHaveValue(
      "list_services",
    );
    await user.clear(screen.getByLabelText("Expected tool 2"));
    expect(callbacks.onToolChange).toHaveBeenLastCalledWith("second", "");
    await user.click(screen.getByRole("button", { name: "Add a tool" }));
    expect(callbacks.onAddTool).toHaveBeenCalledOnce();
    await user.click(
      screen.getByRole("button", { name: "Remove expected tool 2" }),
    );
    expect(callbacks.onToolRemove).toHaveBeenCalledWith("second");
  });
  it("keeps the required exact-order rule accessible in the options menu", async () => {
    const user = userEvent.setup();
    const callbacks = mount();
    await user.click(
      screen.getByRole("button", {
        name: "Options for Tools must be called in this exact order",
      }),
    );
    expect(screen.getByText("Required check")).toBeVisible();
    expect(
      screen.getByText(/Calls must follow this order, with no extra calls/),
    ).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(callbacks.onRemove).toHaveBeenCalledOnce();
  });
});
