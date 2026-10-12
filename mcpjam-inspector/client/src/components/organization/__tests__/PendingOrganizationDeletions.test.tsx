vi.mock("@/lib/error-reporting", () => ({ reportBoundaryError: mocks.report }));
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PendingOrganizationDeletions } from "../PendingOrganizationDeletions";
const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  pending: [] as { organizationId: string; name: string; purgeAfter: number }[],
  unavailable: false,
  cancel: vi.fn(),
  end: vi.fn(),
  error: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => { if (mocks.unavailable) throw new Error("Server Error"); return mocks.pending; },
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
  mocks.unavailable = false;
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

afterEach(() => { vi.useRealTimers(); });
it("isolates an unavailable backend function from the app", () => {
  mocks.unavailable = true;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  render(<><span>App remains available</span><PendingOrganizationDeletions /></>);
  expect(screen.getByText("App remains available")).toBeInTheDocument();
  expect(screen.queryByText("Deletion scheduled for Example")).not.toBeInTheDocument();
  error.mockRestore();
});
it("disables cancellation when the deadline passes without a query update", () => {
  vi.useFakeTimers();
  mocks.pending[0].purgeAfter = Date.now() + 1000;
  render(<PendingOrganizationDeletions />);
  expect(screen.getByRole("button", { name: "Cancel deletion" })).toBeEnabled();
  act(() => vi.advanceTimersByTime(1001));
  expect(screen.getByRole("button", { name: "Cancel deletion" })).toBeDisabled();
});

it("reports unexpected failures and recovers automatically", () => {
  vi.useFakeTimers();
  mocks.unavailable = true;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  render(<PendingOrganizationDeletions />);
  expect(mocks.report).toHaveBeenCalled();
  mocks.unavailable = false;
  act(() => vi.advanceTimersByTime(30_001));
  expect(screen.getByText("Deletion scheduled for Example")).toBeInTheDocument();
  log.mockRestore();
});
it("does not schedule deadline timers with no pending deletion", () => {
  vi.useFakeTimers();
  mocks.pending = [];
  render(<PendingOrganizationDeletions />);
  expect(vi.getTimerCount()).toBe(0);
});
