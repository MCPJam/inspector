import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  receipt: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("@/lib/account-deletion-storage", () => ({
  loadAccountDeletion: mocks.load,
  clearActiveAccountDeletion: mocks.clear,
}));
vi.mock("@mcpjam/sdk/account-deletion", () => ({
  AccountDeletionClient: vi.fn().mockImplementation(function () {
    return { receipt: mocks.receipt };
  }),
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => {
    throw new Error("Receipt must not require auth");
  },
}));
vi.mock("convex/react", () => ({
  useQuery: () => {
    throw new Error("Receipt must not subscribe");
  },
}));
import { AccountDeletionReceiptPage } from "../AccountDeletionReceiptPage";
const recovery = {
  localId: "local",
  receiptSecret: "a".repeat(64),
  idempotencyKey: "original-key",
};
const receipt = {
  requestId: "request_a",
  scope: { type: "account", id: "user_a" },
  state: "accepted",
  acceptedAt: 1,
  dueAt: 2,
  canCancel: false,
  journalConfirmedAt: null,
  liveDataDeletedAt: null,
  closedAt: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(recovery);
  mocks.receipt.mockResolvedValue(receipt);
});
it("reads after sign-out without identity/bootstrap and never offers cancellation", async () => {
  render(<AccountDeletionReceiptPage localId="local" />);
  expect(
    await screen.findByRole("heading", { name: "Deletion started" }),
  ).toBeInTheDocument();
  expect(mocks.receipt).toHaveBeenCalledWith({
    receiptSecret: recovery.receiptSecret,
    idempotencyKey: recovery.idempotencyKey,
  });
  expect(
    screen.queryByRole("button", { name: /cancel/i }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/Deletion completed/)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain(recovery.receiptSecret);
});
it("null recovery keeps its same secret/key on refresh without resubmission", async () => {
  mocks.receipt.mockResolvedValue(null);
  render(<AccountDeletionReceiptPage localId="local" />);
  await screen.findByRole("heading", { name: "Deletion status unavailable" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await waitFor(() => expect(mocks.receipt).toHaveBeenCalledTimes(2));
  expect(mocks.receipt.mock.calls[0]).toEqual(mocks.receipt.mock.calls[1]);
  expect(mocks.clear).not.toHaveBeenCalled();
});
it.each(["accepted", "waiting_to_purge", "closed"])(
  "does not claim completion for %s without actual terminal timestamps",
  async (state) => {
    mocks.receipt.mockResolvedValue({
      ...receipt,
      state,
      journalConfirmedAt: 1,
    });
    render(<AccountDeletionReceiptPage localId="local" />);
    expect(
      await screen.findByRole("heading", { name: "Deletion started" }),
    ).toBeInTheDocument();
  },
);
it("distinguishes verified live removal from final closure", async () => {
  mocks.receipt.mockResolvedValue({
    ...receipt,
    state: "live_data_deleted",
    liveDataDeletedAt: 10,
  });
  render(<AccountDeletionReceiptPage localId="local" />);
  expect(
    await screen.findByRole("heading", { name: "Live data deletion verified" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Deletion completed" }),
  ).not.toBeInTheDocument();
});
it("missing browser storage offers support without sign-in or an intake call", async () => {
  mocks.load.mockResolvedValue(null);
  render(<AccountDeletionReceiptPage localId="local" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no recovery record",
  );
  expect(mocks.receipt).not.toHaveBeenCalled();
});
