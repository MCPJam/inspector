import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The organization spend budget section.
 *
 * Three things this covers that nothing else does: the dollars↔credits
 * conversion at the form boundary (the backend stores credits, the admin
 * types dollars), the read-only view a member gets, and the self-enforced
 * refusal for a personal org — the nav strip already hides the tab, but the
 * section must also answer for someone who types the URL.
 */

const mockUseOrgSpendBudget = vi.fn();
const setBudgetMock = vi.fn();
const clearBudgetMock = vi.fn();

vi.mock("@/hooks/useOrgSpendBudget", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/useOrgSpendBudget")
  >("@/hooks/useOrgSpendBudget");
  return {
    ...actual,
    useOrgSpendBudget: (...args: unknown[]) => mockUseOrgSpendBudget(...args),
  };
});

vi.mock("@/hooks/use-org-model-config", () => ({
  useOrgModelUsageSummary: () => ({ summary: undefined, isLoading: false }),
}));

vi.mock("../OrganizationModelsSection", () => ({
  UsageSummaryCard: () => <div data-testid="usage-card-stub" />,
}));

import { OrganizationSpendBudgetSection } from "../OrganizationSpendBudgetSection";

const WINDOW_ENDS_AT = Date.UTC(2026, 2, 1);

const budget = {
  capCredits: 5000,
  alertPercents: [80],
  consumedCredits: 4000,
  windowStartAt: Date.UTC(2026, 1, 1),
  windowEndsAt: WINDOW_ENDS_AT,
  alertedPercents: [80],
  capReachedAt: null,
  updatedAt: Date.UTC(2026, 1, 2),
  updatedByUserId: "user-1",
  minCapCredits: 100,
  maxCapCredits: 100_000_000,
  maxAlertCount: 5,
  supported: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseOrgSpendBudget.mockReturnValue({
    budget,
    isLoading: false,
    error: null,
    isSaving: false,
    setBudget: setBudgetMock,
    clearBudget: clearBudgetMock,
  });
});

describe("OrganizationSpendBudgetSection", () => {
  it("shows the meter in dollars with the reset date", () => {
    render(
      <OrganizationSpendBudgetSection organizationId="org-1" isAdmin={true} />,
    );
    // Credits are cents on the wire; the reader sees dollars.
    expect(screen.getByText(/\$40\.00/)).toBeInTheDocument();
    expect(screen.getByText(/of \$50\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Resets/)).toBeInTheDocument();
    expect(screen.getByText(/Alerted this period at 80%/)).toBeInTheDocument();
  });

  it("saves the typed dollars as whole credits", async () => {
    const user = userEvent.setup();
    render(
      <OrganizationSpendBudgetSection organizationId="org-1" isAdmin={true} />,
    );
    const capInput = screen.getByLabelText("Budget (USD)");
    await user.clear(capInput);
    await user.type(capInput, "125.50");
    await user.click(screen.getByRole("button", { name: /Save budget/ }));

    expect(setBudgetMock).toHaveBeenCalledWith({
      capCredits: 12550,
      alertPercents: [80],
    });
  });

  it("rejects a blank budget instead of reading it as zero", async () => {
    // `Number("")` is 0, which would silently cap the org at nothing.
    const user = userEvent.setup();
    render(
      <OrganizationSpendBudgetSection organizationId="org-1" isAdmin={true} />,
    );
    await user.clear(screen.getByLabelText("Budget (USD)"));
    await user.click(screen.getByRole("button", { name: /Save budget/ }));

    expect(setBudgetMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Enter a budget amount in dollars/),
    ).toBeInTheDocument();
  });

  it("rejects an out-of-range alert threshold before calling the server", async () => {
    const user = userEvent.setup();
    render(
      <OrganizationSpendBudgetSection organizationId="org-1" isAdmin={true} />,
    );
    const alerts = screen.getByLabelText("Alert at (% of budget)");
    await user.clear(alerts);
    await user.type(alerts, "150");
    await user.click(screen.getByRole("button", { name: /Save budget/ }));

    expect(setBudgetMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/whole percents between 1 and 99/),
    ).toBeInTheDocument();
  });

  it("gives a member the meter but no controls", () => {
    render(
      <OrganizationSpendBudgetSection organizationId="org-1" isAdmin={false} />,
    );
    expect(screen.getByText(/of \$50\.00/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Budget (USD)")).toBeNull();
    expect(
      screen.getByText("Only owners and admins can change the budget."),
    ).toBeInTheDocument();
  });

  it("says the budget is reached rather than suggesting a top-up", () => {
    // Buying credits does not raise a ceiling an admin set, so this surface
    // must never send anyone to checkout for it.
    mockUseOrgSpendBudget.mockReturnValue({
      budget: { ...budget, consumedCredits: 5000, capReachedAt: 1 },
      isLoading: false,
      error: null,
      isSaving: false,
      setBudget: setBudgetMock,
      clearBudget: clearBudgetMock,
    });
    render(
      <OrganizationSpendBudgetSection organizationId="org-1" isAdmin={true} />,
    );
    expect(screen.getByText(/Budget reached/)).toBeInTheDocument();
    expect(
      screen.getByText(/an owner or admin raises the cap/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/top up/i)).toBeNull();
    expect(screen.queryByText(/buy credits/i)).toBeNull();
  });

  it("says uncapped when no budget is set", () => {
    mockUseOrgSpendBudget.mockReturnValue({
      budget: { ...budget, capCredits: null, consumedCredits: 0 },
      isLoading: false,
      error: null,
      isSaving: false,
      setBudget: setBudgetMock,
      clearBudget: clearBudgetMock,
    });
    render(
      <OrganizationSpendBudgetSection organizationId="org-1" isAdmin={true} />,
    );
    expect(
      screen.getByText(/this organization is uncapped/),
    ).toBeInTheDocument();
    // Nothing to remove yet.
    expect(screen.queryByRole("button", { name: /Remove budget/ })).toBeNull();
  });

  it("self-enforces the personal-org refusal for a hand-typed URL", () => {
    mockUseOrgSpendBudget.mockReturnValue({
      budget: { ...budget, supported: false },
      isLoading: false,
      error: null,
      isSaving: false,
      setBudget: setBudgetMock,
      clearBudget: clearBudgetMock,
    });
    render(
      <OrganizationSpendBudgetSection organizationId="org-1" isAdmin={true} />,
    );
    expect(
      screen.getByText("Personal organizations cannot set a spend budget."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Budget (USD)")).toBeNull();
  });

  it("renders a loading state rather than a blank page while the answer is in flight", () => {
    // `undefined` is "not asked yet", never "no".
    mockUseOrgSpendBudget.mockReturnValue({
      budget: undefined,
      isLoading: true,
      error: null,
      isSaving: false,
      setBudget: setBudgetMock,
      clearBudget: clearBudgetMock,
    });
    render(
      <OrganizationSpendBudgetSection organizationId="org-1" isAdmin={true} />,
    );
    expect(screen.getByText(/Loading budget/)).toBeInTheDocument();
  });
});

describe("OrganizationSpendBudgetSection — waiting vs refusing", () => {
  it("waits while the actor is still settling, rather than claiming a personal org", () => {
    // A hosted cold load resolves the actor asynchronously. Telling a real
    // admin their organization is personal for the moment it takes to find
    // out otherwise is a confident wrong answer — worse than a spinner.
    mockUseOrgSpendBudget.mockReturnValue({
      budget: undefined,
      isLoading: true,
      querySkipped: false,
      error: null,
      isSaving: false,
      setBudget: setBudgetMock,
      clearBudget: clearBudgetMock,
    });
    render(<OrganizationSpendBudgetSection organizationId="org_1" isAdmin />);
    expect(screen.getByText(/loading budget/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/personal organizations cannot/i),
    ).not.toBeInTheDocument();
  });

  it("answers a resolved guest instead of spinning at them forever", () => {
    // The query is skipped for a guest and stays skipped, so treating
    // `budget === undefined` as pending never resolves.
    mockUseOrgSpendBudget.mockReturnValue({
      budget: undefined,
      isLoading: false,
      querySkipped: true,
      error: null,
      isSaving: false,
      setBudget: setBudgetMock,
      clearBudget: clearBudgetMock,
    });
    render(<OrganizationSpendBudgetSection organizationId="org_1" isAdmin />);
    expect(
      screen.getByText(/personal organizations cannot/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/loading budget/i)).not.toBeInTheDocument();
  });
});
