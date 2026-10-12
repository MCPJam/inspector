import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PendingOrganizationDeletions } from "../PendingOrganizationDeletions";
const mocks = vi.hoisted(() => ({
  pending: [] as { organizationId: string; name: string; purgeAfter: number }[],
  cancel: vi.fn(),
  end: vi.fn(),
  error: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => mocks.pending,
  useMutation: () => mocks.cancel,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("@/stores/organization-deletion-store", () => ({
  endOrganizationDeletion: mocks.end,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: mocks.error },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = [
    {
      organizationId: "org",
      name: "Example",
      purgeAfter: Date.now() + 3600_000,
    },
  ];
});
it("shows the held organization and restores its local access state after cancellation", async () => {
  mocks.cancel.mockResolvedValue({ success: true });
  render(<PendingOrganizationDeletions />);
  expect(
    screen.getByText("Deletion scheduled for Example"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel deletion" }));
  await waitFor(() => expect(mocks.end).toHaveBeenCalledWith("org"));
  expect(mocks.cancel).toHaveBeenCalledWith({ organizationId: "org" });
});
it("keeps the banner available and reports a rejected cancellation", async () => {
  mocks.cancel.mockRejectedValue(new Error("Cancellation window closed"));
  render(<PendingOrganizationDeletions />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel deletion" }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  expect(mocks.end).not.toHaveBeenCalled();
});
it("renders nothing when the owner has no pending deletions", () => {
  mocks.pending = [];
  const { container } = render(<PendingOrganizationDeletions />);
  expect(container).toBeEmptyDOMElement();
});
