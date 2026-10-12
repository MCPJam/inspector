import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  inspect: vi.fn(),
  start: vi.fn(),
  signOut: vi.fn(),
  actor: "user_a" as string | undefined,
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: mocks.actor ? { id: mocks.actor } : undefined,
    signOut: mocks.signOut,
  }),
}));
vi.mock("@/lib/account-deletion-flow", () => ({
  accountDeletionClient: () => ({
    capabilities: mocks.capabilities,
    inspect: mocks.inspect,
  }),
  startAccountDeletion: mocks.start,
  useAccountDeletionFlow: () => ({ error: "", busy: false }),
}));
import { AccountDeletionSection } from "../AccountDeletionSection";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor = "user_a";
  mocks.capabilities.mockResolvedValue({ available: true });
  mocks.inspect.mockResolvedValue({
    ready: true,
    checkpointSha256: "c".repeat(64),
    identityCoverageReady: true,
    obligations: [],
  });
});
it("requires explicit confirmation and uses the server ownership checkpoint", async () => {
  render(<AccountDeletionSection />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete account" }),
  );
  expect(mocks.start).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog")).toHaveTextContent("cannot cancel");
  fireEvent.click(
    screen.getByRole("button", { name: "Start account deletion" }),
  );
  expect(mocks.start).toHaveBeenCalledWith(
    "user_a",
    "c".repeat(64),
    mocks.signOut,
    expect.any(Function),
  );
  expect(mocks.start.mock.calls[0][3]()).toBe("user_a");
});
it("disabled capability does not inspect, submit or offer immediate deletion", async () => {
  mocks.capabilities.mockResolvedValue({ available: false });
  render(<AccountDeletionSection />);
  await screen.findByText(/Account deletion is unavailable/);
  expect(screen.getByRole("button", { name: "Delete account" })).toBeDisabled();
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});
it("ownership transfer and identity gaps block submission without a cascade", async () => {
  mocks.inspect.mockResolvedValue({
    ready: false,
    identityCoverageReady: false,
    checkpointSha256: "c".repeat(64),
    obligations: [{ code: "transfer_ownership", organizationId: "org_b" }],
  });
  render(<AccountDeletionSection />);
  await screen.findByText(/Transfer organization ownership/);
  expect(
    screen.getByRole("link", { name: "View organization" }),
  ).toHaveAttribute("href", "/organizations/org_b/members");
  expect(screen.getByRole("button", { name: "Delete account" })).toBeDisabled();
  expect(mocks.start).not.toHaveBeenCalled();
});
it("capability failure cannot enable deletion and can be rechecked", async () => {
  mocks.capabilities.mockRejectedValueOnce(new Error("offline"));
  render(<AccountDeletionSection />);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Delete account" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Check requirements" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Delete account" }),
    ).toBeEnabled(),
  );
});

it("the dispatched getter observes actor changes and cannot authorize an unmounted settings section", async () => {
  const view = render(<AccountDeletionSection />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Delete account" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Start account deletion" }),
  );
  const currentActor: () => string | undefined = mocks.start.mock.calls[0][3];
  expect(currentActor()).toBe("user_a");
  mocks.actor = "user_b";
  view.rerender(<AccountDeletionSection />);
  expect(currentActor()).toBe("user_b");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Start account deletion" }),
    ).toBeEnabled(),
  );
  mocks.actor = undefined;
  view.rerender(<AccountDeletionSection />);
  expect(currentActor()).toBeUndefined();
  view.unmount();
  expect(currentActor()).toBe("");
});
