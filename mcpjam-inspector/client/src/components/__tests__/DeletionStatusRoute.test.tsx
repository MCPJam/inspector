import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { read, cancel, token, signIn, auth, recover, params } = vi.hoisted(() => ({
  recover: vi.fn(),
  params: { requestId: "request_1" },
  read: vi.fn(),
  cancel: vi.fn(),
  token: vi.fn(),
  signIn: vi.fn(),
  auth: { isLoading: false, user: { id: "owner" } as { id: string } | null },
}));
vi.mock("react-router", () => ({
  useParams: () => params,
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ ...auth, getAccessToken: token, signIn }),
}));
vi.mock("@/lib/apis/deletion-api", () => ({
  readDeletion: read,
  recoverDeletion: recover,
  cancelDeletion: cancel,
}));
import { DeletionStatusRoute } from "../DeletionStatusRoute";

const receipt = {
  requestId: "request_1",
  scope: { type: "organization", id: "org_1" },
  state: "waiting_to_purge",
  acceptedAt: 1,
  purgeAfter: 100,
  canCancel: true,
  liveDataDeletedAt: null,
  closedAt: null,
  attentionCode: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  params.requestId = "request_1";
  auth.user = { id: "owner" };
  auth.isLoading = false;
  read.mockResolvedValue(receipt);
});
it("loads a direct link with the current token without mounting the project shell", async () => {
  render(<DeletionStatusRoute />);
  expect(
    await screen.findByRole("button", { name: "Cancel deletion" }),
  ).toBeEnabled();
  expect(read).toHaveBeenCalledWith("request_1", token);
  expect(screen.queryByText(/project settings/i)).not.toBeInTheDocument();
});
it("requires sign-in before reading or cancelling", async () => {
  auth.user = null;
  render(<DeletionStatusRoute />);
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(signIn).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});
it("removes cancellation when the backend denies current authority", async () => {
  read.mockResolvedValue({ ...receipt, canCancel: false });
  render(<DeletionStatusRoute />);
  await screen.findByRole("button", { name: "Refresh status" });
  expect(
    screen.queryByRole("button", { name: "Cancel deletion" }),
  ).not.toBeInTheDocument();
});
it("refreshes authority and preserves a visible failure when cancellation is refused", async () => {
  cancel.mockRejectedValue(new Error("Owner removed"));
  render(<DeletionStatusRoute />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel deletion" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cancellation could not be confirmed. Refresh status to check this request.",
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(cancel).toHaveBeenCalledWith("request_1", token);
});
it("shows cancellation as pending without claiming access has been restored", async () => {
  cancel.mockResolvedValue({
    ...receipt,
    state: "cancel_pending",
    canCancel: false,
  });
  render(<DeletionStatusRoute />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel deletion" }),
  );
  expect(
    await screen.findByText(/Access remains paused until confirmation/),
  ).toBeInTheDocument();
});

it("checks an uncertain request outside the shell and cancels using its recovered receipt", async () => {
  params.requestId = "pending";
  recover.mockResolvedValue({ ...receipt });
  render(<DeletionStatusRoute />);
  expect(screen.getByText("Checking deletion request…")).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Cancel deletion" }));
  expect(recover).toHaveBeenCalledWith(window.location.search, token);
  expect(cancel).toHaveBeenCalledWith("request_1", token);
  expect(read).not.toHaveBeenCalled();
});
