import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi, beforeEach } from "vitest";
const { availability } = vi.hoisted(() => ({ availability: vi.fn() }));
vi.mock("@/lib/apis/deletion-api", () => ({ readDeletionAvailability: availability }));
beforeEach(() => { availability.mockReset(); availability.mockResolvedValue(true); });
import { DeleteOrganizationDialog } from "../DeleteOrganizationDialog";
it("requires the exact name and both acknowledgements, and resets on reopening", async () => {
  const props = {
    open: true,
    name: "Acme",
    hasCancellationWindow: true,
    pending: false,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn().mockResolvedValue(undefined),
  };
  const { rerender } = render(<DeleteOrganizationDialog {...props} />);
  expect(
    await screen.findByText(/48-hour cancellation window.*Running sandboxes may expire/),
  ).toBeInTheDocument();
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
  expect(screen.getByRole("button", { name: "Starting deletion…" })).toBeDisabled();
  expect(action).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  rerender(<DeleteOrganizationDialog {...props} open={false} />);
  rerender(<DeleteOrganizationDialog {...props} />);
  expect(screen.getByPlaceholderText("Organization name")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Permanently delete organization" }),
  ).toBeDisabled();
});

it("does not promise a hold when the legacy workflow is active", async () => {
  availability.mockResolvedValue(false);
  render(<DeleteOrganizationDialog open name="Acme" hasCancellationWindow pending={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
  expect(await screen.findByText(/immediately removes the organization/)).toBeInTheDocument();
  expect(screen.queryByText(/48-hour/)).not.toBeInTheDocument();
});
it("does not allow confirmation when availability cannot be checked", async () => {
  availability.mockRejectedValue(new Error("Offline"));
  render(<DeleteOrganizationDialog open name="Acme" hasCancellationWindow pending={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
  expect(await screen.findByText(/Close this dialog and try again/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Permanently delete organization" })).toBeDisabled();
});
