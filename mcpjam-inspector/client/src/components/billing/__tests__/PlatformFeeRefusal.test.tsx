import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const state = vi.hoisted(() => ({
  role: "admin" as "owner" | "admin" | "member",
  topUpEligible: true as boolean | undefined,
  autoReload: "not_configured" as string,
  recipients: [{ email: "dana@acme.test", name: "Dana Ruiz" }],
  navigate: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/lib/active-organization-storage", () => ({
  readStoredActiveOrganizationId: () => "org-1",
}));
vi.mock("@/hooks/useOrganizations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOrganizations")>()),
  useOrganizationQueries: () => ({
    isLoading: false,
    sortedOrganizations: [
      { _id: "org-1", name: "Acme", myRole: state.role, isCreator: false },
    ],
  }),
}));
vi.mock("@/hooks/useCreditBalance", () => ({
  useCreditBalance: () => ({
    balance: { topUpEligible: state.topUpEligible },
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useAutoTopup", () => ({
  useAutoTopup: () => ({ view: { status: state.autoReload } }),
}));
vi.mock("@/hooks/use-upgrade-request-recipients", () => ({
  useUpgradeRequestRecipients: () => ({
    recipients: state.recipients,
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useCreditTopup", () => ({
  useCreditTopupPresets: () => ({
    presets: [{ packageId: "credits_500" }],
    isLoading: false,
  }),
}));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => state.navigate,
  buildOrganizationPath: (id: string, section: string) =>
    `/organizations/${id}/${section}`,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../CreditTopupDialog", () => ({
  CreditTopupDialog: () => <div>credit-topup-dialog</div>,
}));
vi.mock("../AutoTopupDialogBody", () => ({
  AutoTopupDialog: ({ open }: { open: boolean }) =>
    open ? <div>auto-reload-dialog</div> : null,
}));

import { PlatformFeeRefusal } from "../PlatformFeeRefusal";

function buttonNames(): string[] {
  return screen
    .queryAllByRole("button")
    .map((button) => button.textContent ?? "");
}

beforeEach(() => {
  state.role = "admin";
  state.topUpEligible = true;
  state.autoReload = "not_configured";
  state.navigate.mockReset();
});

describe("PlatformFeeRefusal", () => {
  it.each(["owner", "admin"] as const)(
    "offers an %s Buy credits first and auto-reload beside it",
    async (role) => {
      state.role = role;
      const user = userEvent.setup();
      render(<PlatformFeeRefusal />);

      expect(
        screen.getByText("Your organization's credits can't pay for this run."),
      ).toBeInTheDocument();
      expect(buttonNames()).toEqual(["Buy credits", "Turn on auto-reload"]);

      await user.click(screen.getByRole("button", { name: "Buy credits" }));
      expect(screen.getByText("credit-topup-dialog")).toBeInTheDocument();
      await user.click(
        screen.getByRole("button", { name: "Turn on auto-reload" }),
      );
      expect(screen.getByText("auto-reload-dialog")).toBeInTheDocument();
    },
  );

  it("offers to manage auto-reload when it is already on", () => {
    state.autoReload = "enrolled";
    render(<PlatformFeeRefusal />);
    expect(buttonNames()).toEqual(["Buy credits", "Manage auto-reload"]);
    expect(screen.getByText(/Auto-reload is already on/)).toBeInTheDocument();
  });

  it("points a plan without top-ups at its plans", async () => {
    state.topUpEligible = false;
    const user = userEvent.setup();
    render(<PlatformFeeRefusal />);
    expect(buttonNames()).toEqual(["Compare plans"]);
    await user.click(screen.getByRole("button", { name: "Compare plans" }));
    expect(state.navigate).toHaveBeenCalledWith("/organizations/org-1/plans");
  });

  it("tells a member who to ask instead of offering billing actions", () => {
    state.role = "member";
    render(<PlatformFeeRefusal />);
    expect(buttonNames()).toEqual([]);
    expect(
      screen.getByText(/Ask an owner or admin to buy credits/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Request credits" }),
    ).toHaveAttribute("href", expect.stringContaining("dana@acme.test"));
    expect(screen.getByText(/Opens a draft to Dana Ruiz/)).toBeInTheDocument();
  });

  it.each(["owner", "member"] as const)(
    "never shows the code or offers a provider key to an %s",
    (role) => {
      state.role = role;
      const { container } = render(<PlatformFeeRefusal />);
      expect(container.textContent).not.toContain("PLATFORM_FEE_REQUIRED");
      expect(container.textContent).not.toMatch(/provider key|API key/i);
    },
  );
});
