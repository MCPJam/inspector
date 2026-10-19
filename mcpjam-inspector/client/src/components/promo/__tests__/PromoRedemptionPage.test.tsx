import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromoRedemptionPage } from "../PromoRedemptionPage";
import { savePromoIntent } from "@/lib/promo-intent";

const mocks = vi.hoisted(() => ({
  user: { id: "account-1" } as { id: string } | null,
  signIn: vi.fn(),
  redeem: vi.fn(),
  context: {
    status: "ready",
    accountExternalId: "account-1",
    credits: 1000,
    label: "AGNTCon",
    cutoff: 2000000000000,
    account: { userId: "user-1", name: "Alex", email: "alex@example.test" },
    organizations: [{ organizationId: "org-1", name: "My organization" }],
  },
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: mocks.user, signIn: mocks.signIn }),
}));
vi.mock("convex/react", () => ({
  useQuery: () => mocks.context,
  useMutation: () => mocks.redeem,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: "account-1" };
  mocks.context.accountExternalId = "account-1";
  savePromoIntent("SYNTH-ETIC1");
});

describe("redemption confirmation", () => {
  it("requires an explicit named submit and keeps authenticated email read-only", async () => {
    mocks.redeem.mockResolvedValue({ status: "refused", code: "invalid_code" });
    render(<PromoRedemptionPage />);
    expect(mocks.redeem).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Account email")).toHaveAttribute("readonly");
    fireEvent.change(screen.getByLabelText("Company"), {
      target: { value: "Student" },
    });
    expect(mocks.redeem).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Redeem to My organization" }),
    );
    await waitFor(() =>
      expect(mocks.redeem).toHaveBeenCalledExactlyOnceWith({
        campaignId: "agntcon-2026",
        code: "SYNTH-ETIC1",
        name: "Alex",
        company: "Student",
        organizationId: "org-1",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This code is not valid",
    );
  });
  it("sign-in never redeems and stores a clean return path", async () => {
    mocks.user = null;
    render(<PromoRedemptionPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in to continue" }),
    );
    await waitFor(() => expect(mocks.signIn).toHaveBeenCalledOnce());
    expect(mocks.redeem).not.toHaveBeenCalled();
    expect(
      sessionStorage.getItem("mcpjam_app_signin_return_path_v1"),
    ).toContain('"path":"/redeem"');
  });
  it("resets form data when the signed-in account changes", () => {
    const { rerender } = render(<PromoRedemptionPage />);
    fireEvent.change(screen.getByLabelText("Company"), {
      target: { value: "Private company" },
    });
    mocks.user = { id: "account-2" };
    mocks.context.accountExternalId = "account-2";
    rerender(<PromoRedemptionPage />);
    expect(screen.getByLabelText("Company")).toHaveValue("");
    expect(mocks.redeem).not.toHaveBeenCalled();
  });
});

it("updates the form when another fragment card is captured without reloading", () => {
  render(<PromoRedemptionPage />);
  savePromoIntent("AAAAA-BBBBB");
  fireEvent(window, new Event("promo-intent-changed"));
  expect(screen.getByLabelText("Card code")).toHaveValue("AAAAA-BBBBB");
  expect(mocks.redeem).not.toHaveBeenCalled();
});

it("does not render cached details from a different account", () => {
  mocks.context.accountExternalId = "previous-account";
  render(<PromoRedemptionPage />);
  expect(screen.queryByLabelText("Account email")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
});
