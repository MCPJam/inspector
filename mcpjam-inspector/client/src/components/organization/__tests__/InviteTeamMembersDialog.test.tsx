import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { InviteTeamMembersDialog } from "../InviteTeamMembersDialog";

const mocks = vi.hoisted(() => ({
  role: "owner",
  addMember: vi.fn(),
  navigate: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({
    sortedOrganizations: [{ _id: "org1", name: "Acme", myRole: mocks.role }],
  }),
  useOrganizationMutations: () => ({ addMember: mocks.addMember }),
}));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mocks.navigate,
  buildOrganizationPath: (id: string, section: string) =>
    `/organizations/${id}/${section}`,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), info: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "owner";
});
const setup = () =>
  render(
    <InviteTeamMembersDialog organizationId="org1" onClose={mocks.close} />,
  );
const send = () => {
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "new@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
};
it("invites an organization member and closes after success", async () => {
  mocks.addMember.mockResolvedValue({ isPending: true });
  setup();
  send();
  await waitFor(() => expect(mocks.close).toHaveBeenCalled());
  expect(mocks.addMember).toHaveBeenCalledWith({
    organizationId: "org1",
    email: "new@example.com",
    role: "member",
  });
});
it("takes required seat payment to members settings", async () => {
  mocks.addMember.mockResolvedValue({ needsSeatPayment: true });
  setup();
  send();
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith("/organizations/org1/members"),
  );
});
it("keeps failed invitations open with their email", async () => {
  mocks.addMember.mockRejectedValue(new Error("Unable to invite"));
  setup();
  send();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unable to invite",
  );
  expect(screen.getByLabelText("Email address")).toHaveValue("new@example.com");
  expect(mocks.close).not.toHaveBeenCalled();
});
it("does not let members submit invitations", () => {
  mocks.role = "member";
  setup();
  expect(screen.getByRole("button", { name: "Send invite" })).toBeDisabled();
});
