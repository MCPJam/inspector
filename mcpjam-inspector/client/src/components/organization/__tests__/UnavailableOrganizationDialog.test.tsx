import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { UnavailableOrganizationDialog } from "../UnavailableOrganizationDialog";

type Props = ComponentProps<typeof UnavailableOrganizationDialog>;

function props(overrides: Partial<Props> = {}): Props {
  return {
    isAuthenticated: true,
    routeTab: "organizations",
    routeOrganizationId: "unavailable-org",
    isLoadingOrganizations: false,
    hasRouteOrganization: false,
    isDeletionPending: false,
    isDeleted: false,
    isSeatPending: false,
    accountEmail: "member@example.com",
    onContinue: vi.fn(),
    ...overrides,
  };
}

describe("UnavailableOrganizationDialog", () => {
  it("keeps the requested URL until the user acknowledges the explanation", async () => {
    function OrganizationRoute() {
      const navigate = useNavigate();
      return (
        <UnavailableOrganizationDialog
          {...props()}
          onContinue={() => navigate("/servers", { replace: true })}
        />
      );
    }
    const router = createMemoryRouter(
      [
        { path: "/organizations/:orgId", element: <OrganizationRoute /> },
        { path: "/servers", element: <div>My project</div> },
        { path: "/playground", element: <div>Playground</div> },
      ],
      { initialEntries: ["/playground", "/organizations/unavailable-org"] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "This organization isn't available",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "You're signed in as member@example.com.",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Sign in with the email address that received the invitation, or ask an organization admin to invite this account.",
    );
    expect(router.state.location.pathname).toBe(
      "/organizations/unavailable-org",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Go to your projects" }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/servers"),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await router.navigate(-1);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/playground"),
    );
  });

  it.each(["Close", "Escape"])(
    "uses the same fallback when dismissed with %s",
    (method) => {
      const input = props();
      render(<UnavailableOrganizationDialog {...input} />);
      if (method === "Close") {
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
      } else {
        fireEvent.keyDown(document, { key: "Escape" });
      }
      expect(input.onContinue).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { isAuthenticated: false },
    { isLoadingOrganizations: true },
    { hasRouteOrganization: true },
    { isDeletionPending: true },
    { routeTab: "servers" },
  ])("does not interrupt a route when %j", (overrides) => {
    const input = props(overrides);
    render(<UnavailableOrganizationDialog {...input} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(input.onContinue).not.toHaveBeenCalled();
  });

  it("waits for memberships to load and recovers if access is granted", () => {
    const input = props({ isLoadingOrganizations: true });
    const { rerender } = render(<UnavailableOrganizationDialog {...input} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(
      <UnavailableOrganizationDialog
        {...input}
        isLoadingOrganizations={false}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(
      <UnavailableOrganizationDialog
        {...input}
        isLoadingOrganizations={false}
        hasRouteOrganization
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(input.onContinue).not.toHaveBeenCalled();
  });

  it("explains pending seat payment without suggesting another account", () => {
    render(
      <UnavailableOrganizationDialog {...props({ isSeatPending: true })} />,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Your seat is awaiting payment. Ask an organization admin to complete the payment.",
    );
    expect(
      screen.queryByText(/Sign in with the email/),
    ).not.toBeInTheDocument();
  });

  it("does not invent an email when the profile has not loaded", () => {
    render(
      <UnavailableOrganizationDialog {...props({ accountEmail: undefined })} />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).not.toHaveTextContent("signed in as");
  });

  it("leaves an organization the user deleted without access advice", () => {
    const input = props({ isDeleted: true });
    render(<UnavailableOrganizationDialog {...input} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(input.onContinue).toHaveBeenCalledTimes(1);
  });

  it("preserves the fallback for an organization route without an ID", () => {
    const input = props({ routeOrganizationId: undefined });
    render(<UnavailableOrganizationDialog {...input} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(input.onContinue).toHaveBeenCalledTimes(1);
  });
});
