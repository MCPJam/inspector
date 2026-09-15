import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DeleteOrganizationDialog } from "../DeleteOrganizationDialog";
it("requires the exact name and both acknowledgements, and resets on reopening", () => {
  const props = {
    open: true,
    name: "Acme",
    pending: false,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn().mockResolvedValue(undefined),
  };
  const { rerender } = render(<DeleteOrganizationDialog {...props} />);
  const action = screen.getByRole("button", {
    name: "Permanently delete organization",
  });
  expect(action).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText("Organization name"), {
    target: { value: "acme" },
  });
  screen
    .getAllByRole("checkbox")
    .forEach((checkbox) => fireEvent.click(checkbox));
  expect(action).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText("Organization name"), {
    target: { value: "Acme" },
  });
  expect(action).toBeEnabled();
  fireEvent.click(action);
  expect(props.onConfirm).toHaveBeenCalledTimes(1);
  rerender(<DeleteOrganizationDialog {...props} pending />);
  expect(action).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  rerender(<DeleteOrganizationDialog {...props} open={false} />);
  rerender(<DeleteOrganizationDialog {...props} />);
  expect(screen.getByPlaceholderText("Organization name")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Permanently delete organization" }),
  ).toBeDisabled();
});
