import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkDomainSettings } from "@/hooks/useWorkOrganization";
import { WorkOrganizationSettings } from "../WorkOrganizationSettings";

const { save, query } = vi.hoisted(() => ({ save: vi.fn(), query: vi.fn() }));
vi.mock("convex/react", () => ({ useMutation: () => save }));
vi.mock("@/hooks/use-soft-query", () => ({ useSoftQuery: () => query() }));
vi.mock("../../settings/SettingsDraftProvider", () => ({
  useSettingsDraft: vi.fn(),
}));
let policy: WorkDomainSettings;
beforeEach(() => {
  save.mockReset().mockResolvedValue({ revision: 2 });
  policy = {
    domain: "acme.com",
    organizationId: "acme",
    automaticJoining: true,
    discoverable: false,
    revision: 1,
    discoveryRevision: 0,
    canManageDefault: true,
    options: [{ organizationId: "acme", name: "Acme" }],
  };
  query.mockImplementation(() => ({ data: policy }));
});

it("saves the observed policy and discovery revisions with the owner’s changes", async () => {
  render(<WorkOrganizationSettings organizationId="acme" />);
  fireEvent.click(
    screen.getByRole("switch", { name: "Automatically join new teammates" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      domain: "acme.com",
      organizationId: "acme",
      automaticJoining: false,
      discoverable: false,
      expectedRevision: 1,
      expectedDiscoveryRevision: 0,
      settingsOrganizationId: "acme",
    }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Email domain settings saved.",
  );
});

it("keeps a failed draft while the owner reviews and retries the latest revision", async () => {
  save.mockRejectedValueOnce({ data: "Email domain settings changed." });
  const view = render(<WorkOrganizationSettings organizationId="acme" />);
  fireEvent.click(
    screen.getByRole("switch", { name: "Automatically join new teammates" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your changes are kept here.",
  );
  policy = { ...policy, revision: 3 };
  view.rerender(<WorkOrganizationSettings organizationId="acme" />);
  expect(
    screen.getByRole("switch", { name: "Automatically join new teammates" }),
  ).not.toBeChecked();
  fireEvent.click(
    screen.getByRole("button", { name: "Keep changes for retry" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ automaticJoining: false, expectedRevision: 3 }),
    ),
  );
});

it("lets a separate organization’s owner save discovery without showing private default controls", async () => {
  policy = {
    ...policy,
    canManageDefault: false,
    organizationId: "private-team",
    options: [],
  };
  render(<WorkOrganizationSettings organizationId="private-team" />);
  expect(
    screen.queryByText("Default work organization"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("switch", { name: "Automatically join new teammates" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("switch", {
      name: "Let coworkers discover this organization",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      organizationId: "private-team",
      discoverable: true,
      expectedRevision: 0,
    }),
  );
});

it("retires an unsaved draft when the displayed domain changes", () => {
  const view = render(<WorkOrganizationSettings organizationId="acme" />);
  fireEvent.click(screen.getByRole("switch", { name: "Automatically join new teammates" }));
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  policy = { ...policy, domain: "other.com" };
  view.rerender(<WorkOrganizationSettings organizationId="acme" />);
  expect(screen.getByRole("switch", { name: "Automatically join new teammates" })).toBeChecked();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
});
