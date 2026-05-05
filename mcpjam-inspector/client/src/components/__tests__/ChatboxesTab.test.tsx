import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatboxesTab } from "../ChatboxesTab";
import { readBuilderSession, writeBuilderSession } from "@/lib/chatbox-session";

const mockBuilderViewProps = vi.fn();
const mockUseFeatureFlagEnabled = vi.fn(() => true);
const mockUseOrganizationBilling = vi.fn();

const chatboxList = [
  {
    chatboxId: "sbx-1",
    projectId: "ws-1",
    name: "Alpha",
    description: "Alpha description",
    hostStyle: "claude" as const,
    mode: "invited_only" as const,
    allowGuestAccess: false,
    serverCount: 1,
    serverNames: ["alpha-server"],
    createdAt: 1,
    updatedAt: 1,
  },
  {
    chatboxId: "sbx-2",
    projectId: "ws-1",
    name: "Beta",
    description: "Beta description",
    hostStyle: "chatgpt" as const,
    mode: "invited_only" as const,
    allowGuestAccess: false,
    serverCount: 1,
    serverNames: ["beta-server"],
    createdAt: 2,
    updatedAt: 2,
  },
];

function createPlanCatalog() {
  return {
    catalogVersion: "mcpjam_pricing_page",
    currency: "usd",
    appOrigin: "http://localhost:5173",
    plans: {
      free: {
        plan: "free",
        displayName: "Free",
        billingModel: "free",
        isSelfServe: false,
        prices: { monthly: 0, annual: 0 },
        features: {
          evals: false,
          chatboxes: false,
          cicd: false,
          customDomains: false,
          auditLog: false,
          sso: false,
          prioritySupport: false,
        },
        limits: {
          maxMembers: 5,
          maxProjects: null,
          maxServersPerProject: null,
          maxChatboxesPerProject: 0,
          maxEvalRunsPerMonth: 5,
        },
        includedSeats: null,
        seatMinimum: null,
        checkout: null,
      },
      pro: {
        plan: "pro",
        displayName: "Pro",
        billingModel: "per_seat",
        isSelfServe: true,
        prices: { monthly: 3000, annual: 28800 },
        features: {
          evals: true,
          chatboxes: true,
          cicd: true,
          customDomains: false,
          auditLog: false,
          sso: false,
          prioritySupport: true,
        },
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxServersPerProject: null,
          maxChatboxesPerProject: 3,
          maxEvalRunsPerMonth: 1000,
        },
        includedSeats: null,
        seatMinimum: null,
        checkout: {
          plan: "pro",
          supportedIntervals: ["monthly", "annual"],
        },
      },
      enterprise: {
        plan: "enterprise",
        displayName: "Enterprise",
        billingModel: "contact",
        isSelfServe: false,
        prices: { monthly: null, annual: null },
        features: {
          evals: true,
          chatboxes: true,
          cicd: true,
          customDomains: true,
          auditLog: true,
          sso: true,
          prioritySupport: true,
        },
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxServersPerProject: null,
          maxChatboxesPerProject: null,
          maxEvalRunsPerMonth: null,
        },
        includedSeats: null,
        seatMinimum: null,
        checkout: null,
      },
    },
  };
}

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
  }),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (...args: unknown[]) =>
    mockUseFeatureFlagEnabled(...args),
}));

vi.mock("@/hooks/useOrganizationBilling", () => ({
  useOrganizationBilling: (...args: unknown[]) =>
    mockUseOrganizationBilling(...args),
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxList: () => ({
    chatboxes: chatboxList,
    isLoading: false,
  }),
  useChatboxMutations: () => ({
    createChatbox: vi.fn(),
    duplicateChatbox: vi.fn(),
    updateChatbox: vi.fn(),
    deleteChatbox: vi.fn(),
    setChatboxMode: vi.fn(),
    rotateChatboxLink: vi.fn(),
    upsertChatboxMember: vi.fn(),
    removeChatboxMember: vi.fn(),
  }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectQueries: () => ({
    projects: [
      {
        _id: "ws-1",
        name: "Project One",
        organizationId: "org-1",
      },
    ],
    isLoading: false,
  }),
  useProjectServers: () => ({
    servers: [],
  }),
}));

vi.mock("../chatboxes/builder/ChatboxBuilderView", () => ({
  ChatboxBuilderView: (props: any) => {
    mockBuilderViewProps(props);

    return (
      <div>
        <h2>Builder view</h2>
        <p>Chatbox: {props.chatboxId ?? "new"}</p>
        <p>Draft: {props.draft?.name ?? "none"}</p>
        <p>Project: {props.projectId ?? "unknown"}</p>
        <p>View mode: {props.initialViewMode ?? "none"}</p>
        <button type="button" onClick={props.onBack}>
          Back to index
        </button>
      </div>
    );
  },
}));

describe("ChatboxesTab", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    mockUseFeatureFlagEnabled.mockReturnValue(true);
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        plan: "pro",
        effectivePlan: "pro",
        canManageBilling: true,
      },
      planCatalog: createPlanCatalog(),
      projectPremiumness: {
        plan: "pro",
        enforcementState: "active",
        effectivePlan: "pro",
        billingInterval: "monthly",
        source: "subscription",
        decisionRequired: false,
        gates: [
          {
            gateKey: "chatboxes",
            kind: "feature",
            scope: "organization",
            canAccess: true,
            shouldShowUpsell: false,
            upgradePlan: null,
            reason: "feature_included",
          },
        ],
      },
      isLoadingBilling: false,
      isLoadingProjectPremiumness: false,
    });
  });

  it("shows a project prompt when no project is selected", () => {
    render(<ChatboxesTab projectId={null} organizationId={null} />);

    expect(
      screen.getByText("Select a project to manage chatboxes."),
    ).toBeInTheDocument();
  });

  it("shows a full-tab loading state while billing context is pending", () => {
    render(
      <ChatboxesTab
        projectId="ws-1"
        organizationId="org-1"
        isBillingContextPending={true}
      />,
    );

    expect(
      screen.getByTestId("chatboxes-billing-context-pending"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Chatboxes")).not.toBeInTheDocument();
    expect(mockUseOrganizationBilling.mock.calls).toEqual([
      [null, { projectId: null }],
      [null, { projectId: null }],
      [null, { projectId: null }],
    ]);
  });

  it("renders the chatbox index once the builder experience loads", async () => {
    render(<ChatboxesTab projectId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByRole(
        "heading",
        { name: "Chatboxes" },
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("opens the clicked chatbox in the builder view", async () => {
    render(<ChatboxesTab projectId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByText("Beta", {}, { timeout: 3000 }));

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Chatbox: sbx-2")).toBeInTheDocument();
    expect(screen.getByText("Project: ws-1")).toBeInTheDocument();
  });

  it("opens the starter launcher from the new chatbox action", async () => {
    render(<ChatboxesTab projectId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New chatbox" }));

    expect(
      await screen.findByText("What would you like to create?"),
    ).toBeInTheDocument();
  });

  it("starts a blank chatbox draft after choosing blank from the launcher", async () => {
    render(<ChatboxesTab projectId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New chatbox" }));
    fireEvent.click(await screen.findByText("Blank chatbox"));

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Chatbox: new")).toBeInTheDocument();
    expect(screen.getByText("Draft: New Chatbox")).toBeInTheDocument();
  });

  it("restores the saved builder session for the active project", async () => {
    writeBuilderSession({
      projectId: "ws-1",
      chatboxId: "sbx-2",
      draft: null,
      viewMode: "preview",
    });

    render(<ChatboxesTab projectId="ws-1" organizationId="org-1" />);

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Chatbox: sbx-2")).toBeInTheDocument();
    expect(screen.getByText("View mode: preview")).toBeInTheDocument();
  });

  it("returns to the chatbox index after leaving the builder", async () => {
    render(<ChatboxesTab projectId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New chatbox" }));
    fireEvent.click(await screen.findByText("Blank chatbox"));
    fireEvent.click(screen.getByRole("button", { name: "Back to index" }));

    expect(
      await screen.findByRole("heading", { name: "Chatboxes" }),
    ).toBeInTheDocument();
  });

  it("shows the upsell gate instead of opening the chatbox surface when chatboxes are denied", async () => {
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        plan: "free",
        effectivePlan: "free",
        canManageBilling: true,
      },
      planCatalog: createPlanCatalog(),
      projectPremiumness: {
        plan: "free",
        enforcementState: "active",
        effectivePlan: "free",
        billingInterval: null,
        source: "free",
        decisionRequired: false,
        gates: [
          {
            gateKey: "chatboxes",
            kind: "feature",
            scope: "organization",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "pro",
            reason: "feature_not_included",
          },
        ],
      },
      isLoadingBilling: false,
      isLoadingProjectPremiumness: false,
    });

    render(<ChatboxesTab projectId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("billing-upsell-gate"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New chatbox" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Builder view")).not.toBeInTheDocument();
  });

  it("clears restored builder sessions when chatboxes are denied", async () => {
    writeBuilderSession({
      projectId: "ws-1",
      chatboxId: "sbx-2",
      draft: null,
      viewMode: "preview",
    });
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        plan: "free",
        effectivePlan: "free",
        canManageBilling: true,
      },
      planCatalog: createPlanCatalog(),
      projectPremiumness: {
        plan: "free",
        enforcementState: "active",
        effectivePlan: "free",
        billingInterval: null,
        source: "free",
        decisionRequired: false,
        gates: [
          {
            gateKey: "chatboxes",
            kind: "feature",
            scope: "organization",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "pro",
            reason: "feature_not_included",
          },
        ],
      },
      isLoadingBilling: false,
      isLoadingProjectPremiumness: false,
    });

    render(<ChatboxesTab projectId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("billing-upsell-gate"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(readBuilderSession("ws-1")).toBeNull();
    });
    expect(screen.queryByText("Builder view")).not.toBeInTheDocument();
  });

  it("shows an inline upgrade upsell when the project chatbox limit is reached", async () => {
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        plan: "pro",
        effectivePlan: "pro",
        canManageBilling: true,
      },
      planCatalog: createPlanCatalog(),
      projectPremiumness: {
        plan: "pro",
        enforcementState: "active",
        effectivePlan: "pro",
        billingInterval: "monthly",
        source: "subscription",
        decisionRequired: false,
        gates: [
          {
            gateKey: "chatboxes",
            kind: "feature",
            scope: "organization",
            canAccess: true,
            shouldShowUpsell: false,
            upgradePlan: null,
            reason: "feature_included",
          },
          {
            gateKey: "maxChatboxesPerProject",
            kind: "limit",
            scope: "project",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "pro",
            reason: "limit_reached",
            currentValue: 1,
            allowedValue: 1,
          },
        ],
      },
      isLoadingBilling: false,
      isLoadingProjectPremiumness: false,
    });

    render(<ChatboxesTab projectId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("chatbox-limit-upsell"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This project has reached its chatbox limit (1). Upgrade to continue.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pro includes 3 chatboxes per project and unlimited members, from $30/mo.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upgrade to Pro" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chatbox" })).toBeDisabled();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("shows owner-directed chatbox upsell copy for non-billing-managers", async () => {
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        plan: "pro",
        effectivePlan: "pro",
        canManageBilling: false,
      },
      planCatalog: createPlanCatalog(),
      projectPremiumness: {
        plan: "pro",
        enforcementState: "active",
        effectivePlan: "pro",
        billingInterval: "monthly",
        source: "subscription",
        decisionRequired: false,
        gates: [
          {
            gateKey: "chatboxes",
            kind: "feature",
            scope: "organization",
            canAccess: true,
            shouldShowUpsell: false,
            upgradePlan: null,
            reason: "feature_included",
          },
          {
            gateKey: "maxChatboxesPerProject",
            kind: "limit",
            scope: "project",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "pro",
            reason: "limit_reached",
            currentValue: 1,
            allowedValue: 1,
          },
        ],
      },
      isLoadingBilling: false,
      isLoadingProjectPremiumness: false,
    });

    render(<ChatboxesTab projectId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("chatbox-limit-upsell"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ask an organization owner to review billing options."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Pro" }),
    ).not.toBeInTheDocument();
  });
});
