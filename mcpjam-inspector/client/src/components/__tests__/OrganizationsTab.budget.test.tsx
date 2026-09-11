import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Budget entry in the org settings strip.
 *
 * Unlike Slack, Discord and Observability the budget is behind no flag, so
 * what gates it is the ORGANIZATION: a personal (guest-owned) org has no
 * admins to configure anything, and must neither show the tab nor render the
 * section for a hand-typed URL.
 *
 * The SECTION additionally re-checks the server's answer — the strip is an
 * advertising decision and access is the server's — which is covered in
 * `organization/__tests__/OrganizationSpendBudgetSection.test.tsx`.
 */

const mockUseAuth = vi.fn();
const mockUseConvexAuth = vi.fn();
const mockUseOrganizationQueries = vi.fn();
const mockUseOrganizationMembers = vi.fn();
const mockUseOrganizationBilling = vi.fn();
const slackFlagMock = vi.fn();
const observabilityFlagMock = vi.fn();

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("@/hooks/useOrgSharePolicy", () => ({
  useOrgSharePolicy: () => ({
    policy: {
      maxShareMode: "anyone_with_link",
      inviteAudience: "anyone",
      updatedAt: null,
    },
    isLoading: false,
    error: null,
    isSaving: false,
    setPolicy: vi.fn(),
  }),
  useEffectiveSharePolicy: () => ({ policy: undefined, isLoading: false }),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/hooks/useSlackAgentSettingsEnabled", () => ({
  useSlackAgentSettingsEnabled: () => slackFlagMock(),
  SLACK_AGENT_ORG_SETTINGS_FEATURE_FLAG: "slack-agent-org-settings",
}));

vi.mock("@/hooks/useTraceDestinationsEnabled", () => ({
  useTraceDestinationsEnabled: () => observabilityFlagMock(),
  TRACE_DESTINATIONS_FEATURE_FLAG: "trace-destinations",
}));

vi.mock("../organization/observability/TraceDestinationsSection", () => ({
  TraceDestinationsSection: () => (
    <div data-testid="observability-section-stub">Trace destinations</div>
  ),
}));

vi.mock("../organization/OrganizationSpendBudgetSection", () => ({
  OrganizationSpendBudgetSection: () => (
    <div data-testid="budget-section-stub">Spend budget</div>
  ),
}));

// The section's own behaviour has its own suite; here it only needs to be
// identifiable so the routing assertion is unambiguous.
vi.mock("../organization/slack/SlackAgentSettingsSection", async () => {
  const actual = await vi.importActual<
    typeof import("../organization/slack/SlackAgentSettingsSection")
  >("../organization/slack/SlackAgentSettingsSection");
  return {
    ...actual,
    SlackAgentSettingsSection: () => (
      <div data-testid="slack-section-stub">Slack settings</div>
    ),
  };
});

vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubChecksAvailability: () => undefined,
}));

vi.mock("@/hooks/useOrganizations", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/useOrganizations")
  >("@/hooks/useOrganizations");
  return {
    ...actual,
    useOrganizationQueries: (...args: unknown[]) =>
      mockUseOrganizationQueries(...args),
    useOrganizationMembers: (...args: unknown[]) =>
      mockUseOrganizationMembers(...args),
    useOrganizationMutations: () => ({
      updateOrganization: vi.fn(),
      deleteOrganization: vi.fn(),
      addMember: vi.fn(),
      changeMemberRole: vi.fn(),
      transferOrganizationOwnership: vi.fn(),
      removeMember: vi.fn(),
      generateLogoUploadUrl: vi.fn(),
      updateOrganizationLogo: vi.fn(),
    }),
  };
});

vi.mock("../organization/OrganizationAuditLog", () => ({
  OrganizationAuditLog: () => <div>Audit Log</div>,
}));

vi.mock("../organization/OrganizationMemberRow", () => ({
  OrganizationMemberRow: ({ member }: any) => <div>{member.email}</div>,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/useOrganizationBilling", () => ({
  useOrganizationBilling: (...args: unknown[]) =>
    mockUseOrganizationBilling(...args),
  isPaidPlan: (plan: string) => plan !== "free",
}));

import { OrganizationsTab } from "../OrganizationsTab";

const organization = {
  _id: "org-1",
  name: "Acme Org",
  createdBy: "user-owner",
  createdAt: 1,
  updatedAt: 1,
  myRole: "owner" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  slackFlagMock.mockReturnValue(true);
  observabilityFlagMock.mockReturnValue(true);
  mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
  mockUseAuth.mockImplementation(() => ({
    user: { email: "owner@example.com" },
    signIn: vi.fn(),
  }));
  mockUseOrganizationQueries.mockReturnValue({
    sortedOrganizations: [organization],
    isLoading: false,
  });
  mockUseOrganizationMembers.mockReturnValue({
    activeMembers: [
      {
        _id: "m1",
        organizationId: "org-1",
        userId: "user-owner",
        email: "owner@example.com",
        role: "owner",
        isOwner: true,
        addedBy: "user-owner",
        addedAt: 1,
        user: { name: "Owner", email: "owner@example.com", imageUrl: "" },
      },
    ],
    pendingMembers: [],
    isLoading: false,
  });
  mockUseOrganizationBilling.mockReturnValue({
    billingStatus: {
      organizationId: "org-1",
      organizationName: "Acme Org",
      plan: "free",
      effectivePlan: "free",
      source: "free",
      billingInterval: null,
      billingConfigured: true,
      subscriptionStatus: null,
      canManageBilling: true,
    },
    organizationPremiumness: undefined,
    planCatalog: undefined,
    isLoadingBilling: false,
    isLoadingEntitlements: false,
    isLoadingPlanCatalog: false,
    isLoadingOrganizationPremiumness: false,
    isStartingPlanChange: false,
    pendingPlanChangeTarget: null,
    isOpeningPortal: false,
    isCancelingScheduledBillingChange: false,
    activeSeatPaymentIntent: null,
    isFinishingSeatPayment: false,
    isCompletingSeatPayment: false,
    isCancelingSeatPayment: false,
    isHandlingSeatPayment: false,
    error: null,
    startPlanChange: vi.fn(),
    openPortal: vi.fn(),
    openCancellationPortal: vi.fn(),
    openIntervalChangePortal: vi.fn(),
    cancelScheduledBillingChange: vi.fn(),
    finishSeatPayment: vi.fn(),
    cancelSeatPayment: vi.fn(),
  });
});

describe("OrganizationsTab Budget section", () => {
  it("shows the Budget tab for an ordinary organization", () => {
    render(<OrganizationsTab organizationId="org-1" />);
    expect(screen.getByRole("button", { name: "Budget" })).toBeInTheDocument();
  });

  it("renders the section for the budget route", () => {
    render(<OrganizationsTab organizationId="org-1" section="budget" />);
    expect(screen.getByTestId("budget-section-stub")).toBeInTheDocument();
  });

  it("hides the Budget tab for a personal organization", () => {
    // A guest's own org exists to give their projects a billing subject. It
    // has no admins, so there is nobody to raise a cap it could set.
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [{ ...organization, isPersonal: true }],
      isLoading: false,
    });
    render(<OrganizationsTab organizationId="org-1" />);
    expect(screen.queryByRole("button", { name: "Budget" })).toBeNull();
  });

  it("falls back to the overview when a personal org's URL says budget", () => {
    mockUseOrganizationQueries.mockReturnValue({
      sortedOrganizations: [{ ...organization, isPersonal: true }],
      isLoading: false,
    });
    render(<OrganizationsTab organizationId="org-1" section="budget" />);
    expect(screen.queryByTestId("budget-section-stub")).toBeNull();
    expect(screen.getByText("Members")).toBeInTheDocument();
  });
});
