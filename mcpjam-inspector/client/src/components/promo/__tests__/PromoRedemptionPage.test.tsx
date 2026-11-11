import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromoRedemptionPage } from "../PromoRedemptionPage";
import { savePromoIntent, clearPromoIntent } from "@/lib/promo-intent";

const mocks = vi.hoisted(() => ({
  user: { id: "account-1" } as { id: string } | null,
  signIn: vi.fn(),
  redeem: vi.fn(),
  override: null as unknown,
  context: {
    status: "ready",
    accountExternalId: "account-1",
    credits: 1000,
    label: "AGNTCon",
    mode: "single_use" as "single_use" | "shared",
    collectLead: true as boolean | undefined,
    cutoff: 2000000000000,
    account: { userId: "user-1", name: "Alex", email: "alex@example.test" },
    organizations: [{ organizationId: "org-1", name: "My organization" }],
  },
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: mocks.user, signIn: mocks.signIn }),
}));
vi.mock("convex/react", () => ({
  useQuery: () => mocks.override ?? mocks.context,
  useMutation: () => mocks.redeem,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: "account-1" };
  mocks.context.organizations = [
    { organizationId: "org-1", name: "My organization" },
  ];
  mocks.context.accountExternalId = "account-1";
  mocks.context.mode = "single_use";
  mocks.context.collectLead = true;
  mocks.override = null;
  window.history.replaceState(null, "", "/redeem");
  savePromoIntent("SYNTH-ETIC1");
});

describe("redemption confirmation", () => {
  it("requires an explicit named submit and shows authenticated email as context", async () => {
    mocks.redeem.mockResolvedValue({ status: "refused", code: "invalid_code" });
    render(<PromoRedemptionPage />);
    expect(mocks.redeem).not.toHaveBeenCalled();
    expect(screen.getByText("Signed in as alex@example.test")).toBeVisible();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.getByLabelText("Full name")).toHaveValue("Alex");
    expect(screen.getByLabelText("Company")).toHaveValue("My organization");
    expect(screen.getByText("SYNTH-ETIC1")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Company"), {
      target: { value: "Student" },
    });
    expect(mocks.redeem).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Claim for My organization" }),
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
    fireEvent.click(screen.getByRole("button", { name: "Sign in to claim" }));
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
    expect(screen.getByLabelText("Company")).toHaveValue("My organization");
    expect(mocks.redeem).not.toHaveBeenCalled();
  });
});

it("updates the form when another fragment card is captured without reloading", () => {
  render(<PromoRedemptionPage />);
  savePromoIntent("AAAAA-BBBBB");
  fireEvent(window, new Event("promo-intent-changed"));
  expect(screen.getByText("AAAAA-BBBBB")).toBeVisible();
  expect(mocks.redeem).not.toHaveBeenCalled();
});

it("does not render cached details from a different account", () => {
  mocks.context.accountExternalId = "previous-account";
  render(<PromoRedemptionPage />);
  expect(screen.queryByLabelText("Account email")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
});

it("suggests company from the destination without overwriting an attendee edit", async () => {
  mocks.context.organizations.push({
    organizationId: "org-2",
    name: "Second team",
  });
  render(<PromoRedemptionPage />);
  fireEvent.click(screen.getByRole("button", { name: "Change destination" }));
  expect(
    screen.getByRole("combobox", { name: "Organization" }),
  ).toHaveTextContent("My organization");
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Organization" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("option", { name: "Second team" }));
  expect(screen.getByLabelText("Company")).toHaveValue("Second team");
  fireEvent.change(screen.getByLabelText("Company"), {
    target: { value: "Independent" },
  });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Organization" }), {
    key: "ArrowDown",
  });
  fireEvent.click(
    await screen.findByRole("option", { name: "My organization" }),
  );
  expect(screen.getByLabelText("Company")).toHaveValue("Independent");
  expect(mocks.redeem).not.toHaveBeenCalled();
});

it("keeps manual code entry open and requires a code before claiming", () => {
  clearPromoIntent();
  render(<PromoRedemptionPage />);
  const submit = screen.getByRole("button", {
    name: "Claim for My organization",
  });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Code printed below the QR"), {
    target: { value: "SYNTH-ETIC1" },
  });
  expect(screen.getByLabelText("Code printed below the QR")).toHaveValue(
    "SYNTH-ETIC1",
  );
  expect(submit).toBeEnabled();
  expect(mocks.redeem).not.toHaveBeenCalled();
});

it("lets an attendee correct a scanned code before submitting", async () => {
  mocks.redeem.mockResolvedValue({ status: "refused", code: "invalid_code" });
  render(<PromoRedemptionPage />);
  fireEvent.click(screen.getByRole("button", { name: "Change code" }));
  fireEvent.change(screen.getByLabelText("Code printed below the QR"), {
    target: { value: "OTHER-CODE1" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Claim for My organization" }),
  );
  await waitFor(() =>
    expect(mocks.redeem).toHaveBeenCalledWith(
      expect.objectContaining({ code: "OTHER-CODE1" }),
    ),
  );
});

it("asks for name and company when an older backend omits collectLead", async () => {
  mocks.context.collectLead = undefined;
  mocks.redeem.mockResolvedValue({ status: "refused", code: "rate_limited" });
  render(<PromoRedemptionPage />);
  expect(screen.getAllByRole("textbox")).toHaveLength(2);
  fireEvent.click(
    screen.getByRole("button", { name: "Claim for My organization" }),
  );
  await waitFor(() =>
    expect(mocks.redeem).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Alex", company: "My organization" }),
    ),
  );
});

describe("shared campaigns", () => {
  beforeEach(() => {
    clearPromoIntent();
    window.history.replaceState(
      null,
      "",
      "/redeem?campaign=maven-evals-0a1b2c3d4e",
    );
    mocks.context.mode = "shared";
  });

  it("asks only for the destination when the campaign collects no leads", async () => {
    mocks.context.collectLead = false;
    mocks.redeem.mockResolvedValue({
      status: "refused",
      code: "campaign_closed",
    });
    render(<PromoRedemptionPage />);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByLabelText("Code printed below the QR")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Claim for My organization" }),
    );
    await waitFor(() =>
      expect(mocks.redeem).toHaveBeenCalledExactlyOnceWith({
        campaignId: "maven-evals-0a1b2c3d4e",
        name: "",
        company: "",
        organizationId: "org-1",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This offer has ended.",
    );
  });

  it("keeps the lead fields but drops the code when the campaign collects leads", async () => {
    mocks.redeem.mockResolvedValue({ status: "refused", code: "rate_limited" });
    render(<PromoRedemptionPage />);
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.queryByLabelText("Code printed below the QR")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Claim for My organization" }),
    );
    await waitFor(() =>
      expect(mocks.redeem).toHaveBeenCalledExactlyOnceWith({
        campaignId: "maven-evals-0a1b2c3d4e",
        name: "Alex",
        company: "My organization",
        organizationId: "org-1",
      }),
    );
  });

  it("names the campaign on an existing receipt", () => {
    mocks.override = {
      status: "already_redeemed",
      accountExternalId: "account-1",
      receipt: {
        canOpenOrganization: true,
        userId: "user-1",
        grantId: "grant-1",
        organizationId: "org-1",
        organizationName: "My organization",
        campaignLabel: "Maven MCP Evals",
        credits: 1000,
        redeemedAt: 1_700_000_000_000,
      },
    };
    render(<PromoRedemptionPage />);
    expect(
      screen.getByText("You've already redeemed your Maven MCP Evals credits."),
    ).toBeVisible();
  });

  it("carries the campaign through sign-in", async () => {
    mocks.user = null;
    render(<PromoRedemptionPage />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to claim" }));
    await waitFor(() =>
      expect(mocks.signIn).toHaveBeenCalledWith({
        state: expect.objectContaining({
          promoCampaign: "maven-evals-0a1b2c3d4e",
        }),
      }),
    );
  });
});
