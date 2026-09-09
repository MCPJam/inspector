import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Observability entry in the org settings strip.
 *
 * The flag has to gate BOTH the tab and the section, and this file covers the
 * tab half: with the flag off, an org admin must not see an entry for a
 * surface most orgs cannot use, and the `/organizations/:id/observability`
 * URL must fall back to the overview rather than rendering a blank settings
 * page.
 *
 * The SECTION additionally re-checks the server's answer — a client flag is
 * an advertising decision and access is the server's — which is covered in
 * `organization/observability/__tests__/TraceDestinationsSection.test.tsx`.
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

describe("OrganizationsTab Observability section", () => {
  it("hides the Observability tab when the flag is off", () => {
    observabilityFlagMock.mockReturnValue(false);
    render(<OrganizationsTab organizationId="org-1" />);
    expect(screen.queryByRole("button", { name: "Observability" })).toBeNull();
  });

  it("shows the Observability tab when the flag is on", () => {
    render(<OrganizationsTab organizationId="org-1" />);
    expect(
      screen.getByRole("button", { name: "Observability" }),
    ).toBeInTheDocument();
  });

  it("renders the section for the observability route", () => {
    render(<OrganizationsTab organizationId="org-1" section="observability" />);
    expect(
      screen.getByTestId("observability-section-stub"),
    ).toBeInTheDocument();
  });

  it("falls back to the overview when the flag is off and the URL says observability", () => {
    // A URL kept from a flagged-in session must land somewhere real rather
    // than on an empty settings page.
    observabilityFlagMock.mockReturnValue(false);
    render(<OrganizationsTab organizationId="org-1" section="observability" />);
    expect(screen.queryByTestId("observability-section-stub")).toBeNull();
    expect(screen.getByText("Members")).toBeInTheDocument();
  });
});
