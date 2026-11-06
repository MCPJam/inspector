import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkOrganizationNotice } from "../WorkOrganizationNotice";
import type { WorkSignupOutcome } from "@/hooks/useWorkOrganization";

const { acknowledge, retry, ensureProject, navigate, query, useWork } =
  vi.hoisted(() => ({
    acknowledge: vi.fn(),
    retry: vi.fn(),
    ensureProject: vi.fn(),
    navigate: vi.fn(),
    query: vi.fn(),
    useWork: vi.fn(),
  }));
vi.mock("@/hooks/useWorkOrganization", () => ({
  useWorkOrganization: () => useWork(),
}));
vi.mock("@/hooks/use-soft-query", () => ({ useSoftQuery: () => query() }));
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => navigate,
}));
let outcome: WorkSignupOutcome;
const props = {
  enabled: true,
  activeOrganizationId: "acme",
  entry: "/p/abcdefghijklmnop/home",
  organizations: [{ _id: "acme", name: "Acme" }],
  projects: [],
};
beforeEach(() => {
  acknowledge.mockReset().mockResolvedValue(null);
  ensureProject.mockReset().mockResolvedValue("abcdefghijklmnop");
  retry.mockReset().mockResolvedValue(null);
  navigate.mockClear();
  outcome = {
    state: "joined",
    domain: "acme.com",
    organizationId: "acme",
    organizationName: "Acme",
    routedAt: 1,
  };
  useWork.mockImplementation(() => ({
    data: outcome,
    acknowledge,
    retry,
    ensureProject,
  }));
  query.mockReturnValue({
    data: [{ organizationId: "research", name: "Acme Research" }],
  });
});

it("keeps invitation instructions inside the organizations dialog and clears them on close", async () => {
  render(<WorkOrganizationNotice {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "View organizations" }));
  fireEvent.click(screen.getByRole("button", { name: "Ask to join" }));
  expect(
    screen.getByText("Ask an admin of Acme Research to invite you."),
  ).toBeVisible();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByText("Ask an admin of Acme Research to invite you."),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View organizations" }));
  expect(
    screen.queryByText("Ask an admin of Acme Research to invite you."),
  ).not.toBeInTheDocument();
});

it("preserves explicit project returns and records their one-time routing decision", async () => {
  outcome = { ...outcome, routedAt: undefined };
  render(<WorkOrganizationNotice {...props} />);
  await waitFor(() =>
    expect(acknowledge).toHaveBeenCalledWith({ action: "routed" }),
  );
  expect(ensureProject).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

it("routes a generic signup to the company Home using an authorized project", async () => {
  outcome = { ...outcome, routedAt: undefined };
  window.history.replaceState({}, "", "/home");
  render(<WorkOrganizationNotice {...props} entry="/home" />);
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith("/p/abcdefghijklmnop/home", {
      replace: true,
    }),
  );
  expect(ensureProject).toHaveBeenCalledWith({ organizationId: "acme" });
});

it("persists dismissal through the backend outcome", async () => {
  render(<WorkOrganizationNotice {...props} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss organization notice" }),
  );
  await waitFor(() =>
    expect(acknowledge).toHaveBeenCalledWith({ action: "dismiss" }),
  );
});
