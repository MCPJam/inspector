import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ConvexError } from "convex/values";
import type { AccessRequest } from "../access-request-api";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const authState = vi.hoisted(() => ({
  user: { id: "user_owner" } as { id: string } | null,
  isLoading: false,
  signIn: vi.fn(),
}));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => authState }));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

const convex = vi.hoisted(() => ({
  request: undefined as AccessRequest | null | undefined,
  decide: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: () => convex.request,
  useMutation: () => convex.decide,
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ toast: { error: toastError } }));

import { AccessRequestPage } from "../AccessRequestPage";

const REQUEST: AccessRequest = {
  requestId: "req_1",
  status: "pending",
  requestedAt: Date.UTC(2026, 10, 14, 9),
  decidedAt: null,
  project: { id: "proj_1", name: "Payments" },
  organizationId: "org_1",
  requester: { name: "Ada Lovelace", email: "ada@example.com" },
  requesterInOrganization: false,
};

function renderPage(search = "") {
  const router = createMemoryRouter(
    [
      { path: "/access-requests/:requestId", element: <AccessRequestPage /> },
      { path: "*", element: <div data-testid="elsewhere" /> },
    ],
    { initialEntries: [`/access-requests/req_1${search}`] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("AccessRequestPage", () => {
  beforeEach(() => {
    authState.user = { id: "user_owner" };
    authState.isLoading = false;
    authState.signIn.mockReset();
    convex.request = { ...REQUEST };
    convex.decide.mockReset();
    toastError.mockReset();
  });

  it("shows the requester, the project, and both decisions", () => {
    renderPage();
    expect(
      screen.getByRole("heading", {
        name: "Ada Lovelace asked for access to Payments",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(
      screen.getByText(/adds Ada Lovelace to your organization/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
  });

  it("only preselects from the link and changes nothing on load", () => {
    renderPage("?decision=decline");
    expect(convex.decide).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Decline" })).toHaveClass(
      "bg-primary",
    );
    expect(screen.getByRole("button", { name: "Approve" })).not.toHaveClass(
      "bg-primary",
    );
  });

  it("shows a neutral page when the request is not available", () => {
    convex.request = null;
    renderPage();
    expect(
      screen.getByText("This request isn't available"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("asks a guest to sign in instead of reading the request", () => {
    authState.user = null;
    renderPage();
    expect(
      screen.getByText("Sign in to review this request"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(authState.signIn).toHaveBeenCalledTimes(1);
  });

  it("says the requester joined the org and the project after approval", async () => {
    convex.decide.mockResolvedValue({
      status: "approved",
      access: "granted",
      addedToOrg: true,
      seatPaymentIntentId: null,
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(convex.decide).toHaveBeenCalledWith({
      requestId: "req_1",
      decision: "approve",
    });
    expect(await screen.findByText("Access granted")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Ada Lovelace joined your organization as a guest and can edit Payments.",
      ),
    ).toBeInTheDocument();
  });

  it("points to organization billing when the approval waits on a seat", async () => {
    convex.decide.mockResolvedValue({
      status: "approved",
      access: "pending",
      addedToOrg: true,
      seatPaymentIntentId: "seat_1",
    });
    const router = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(
      await screen.findByText("Approved, waiting on a seat payment"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/An organization owner has to finish/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open organization billing" }),
    );
    expect(router.state.location.pathname).toBe("/organizations/org_1/billing");
  });

  it("keeps billing in view when an approval is pending without a seat payment", async () => {
    // A second approval of a paid-seat request returns no seat payment.
    convex.decide.mockResolvedValue({
      status: "approved",
      access: "pending",
      addedToOrg: true,
      seatPaymentIntentId: null,
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(
      await screen.findByText("Approved, access not active yet"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /after an organization owner finishes an open seat payment/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open organization billing" }),
    ).toBeInTheDocument();
  });

  it("does not say a declined requester lost access they still have", async () => {
    // Declining an older request after a newer one was approved.
    convex.decide.mockResolvedValue({ status: "declined", access: "granted" });
    renderPage("?decision=decline");
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(
      await screen.findByText(
        "You declined this request. Ada Lovelace still has access to Payments.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/does not have access/)).toBeNull();
  });

  it("says who has to approve when a paid seat needs an org owner", async () => {
    convex.decide.mockRejectedValue(
      new ConvexError({ code: "SEAT_PAYMENT_OWNER_REQUIRED", message: "x" }),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(
      await screen.findByText("An organization owner has to approve this"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open organization billing" }),
    ).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says another seat payment is open", async () => {
    convex.decide.mockRejectedValue(
      new ConvexError({ code: "SEAT_PAYMENT_IN_PROGRESS", message: "x" }),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(
      await screen.findByText("Another seat payment is open"),
    ).toBeInTheDocument();
  });

  it("shows the earlier decision instead of the buttons", () => {
    convex.request = {
      ...REQUEST,
      status: "declined",
      decidedAt: Date.UTC(2026, 10, 14, 12),
    };
    renderPage();
    expect(screen.getByText("Request already declined")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
