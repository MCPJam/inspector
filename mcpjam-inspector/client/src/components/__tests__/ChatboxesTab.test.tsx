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
    workspaceId: "ws-1",
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
    workspaceId: "ws-1",
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
          maxMembers: 1,
          maxWorkspaces: 1,
          maxServersPerWorkspace: 3,
          maxChatboxesPerWorkspace: 0,
          maxEvalRunsPerMonth: 5,
        },
        includedSeats: null,
        seatMinimum: null,
        checkout: null,
      },
      starter: {
        plan: "starter",
        displayName: "Starter",
        billingModel: "flat",
        isSelfServe: true,
        prices: { monthly: 6100, annual: 58800 },
        features: {
          evals: true,
          chatboxes: true,
          cicd: true,
          customDomains: false,
          auditLog: false,
          sso: false,
          prioritySupport: false,
        },
        limits: {
          maxMembers: 3,
          maxWorkspaces: 2,
          maxServersPerWorkspace: 10,
          maxChatboxesPerWorkspace: 1,
          maxEvalRunsPerMonth: 500,
        },
        includedSeats: 3,
        seatMinimum: null,
        checkout: {
          plan: "starter",
          supportedIntervals: ["monthly", "annual"],
        },
      },
      team: {
        plan: "team",
        displayName: "Team",
        billingModel: "per_seat",
        isSelfServe: true,
        prices: { monthly: 7400, annual: 70800 },
        features: {
          evals: true,
          chatboxes: true,
          cicd: true,
          customDomains: true,
          auditLog: false,
          sso: true,
          prioritySupport: true,
        },
        limits: {
          maxMembers: 100,
          maxWorkspaces: 10,
          maxServersPerWorkspace: null,
          maxChatboxesPerWorkspace: 3,
          maxEvalRunsPerMonth: 5000,
        },
        includedSeats: null,
        seatMinimum: 4,
        checkout: {
          plan: "team",
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
          maxWorkspaces: null,
          maxServersPerWorkspace: null,
          maxChatboxesPerWorkspace: null,
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

vi.mock("@/hooks/useWorkspaces", () => ({
  useWorkspaceQueries: () => ({
    workspaces: [
      {
        _id: "ws-1",
        name: "Workspace One",
        organizationId: "org-1",
      },
    ],
    isLoading: false,
  }),
  useWorkspaceServers: () => ({
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
        <p>Workspace: {props.workspaceId ?? "unknown"}</p>
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
        plan: "starter",
        effectivePlan: "starter",
        canManageBilling: true,
      },
      planCatalog: createPlanCatalog(),
      workspacePremiumness: {
        plan: "starter",
        enforcementState: "active",
        effectivePlan: "starter",
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
      isLoadingWorkspacePremiumness: false,
    });
  });

  it("shows a workspace prompt when no workspace is selected", () => {
    render(<ChatboxesTab workspaceId={null} organizationId={null} />);

    expect(
      screen.getByText("Select a workspace to manage chatboxes."),
    ).toBeInTheDocument();
  });

  it("shows a full-tab loading state while billing context is pending", () => {
    render(
      <ChatboxesTab
        workspaceId="ws-1"
        organizationId="org-1"
        isBillingContextPending={true}
      />,
    );

    expect(
      screen.getByTestId("chatboxes-billing-context-pending"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Chatboxes")).not.toBeInTheDocument();
    expect(mockUseOrganizationBilling.mock.calls).toEqual([
      [null, { workspaceId: null }],
      [null, { workspaceId: null }],
      [null, { workspaceId: null }],
    ]);
  });

  it("renders the chatbox index once the builder experience loads", async () => {
    render(<ChatboxesTab workspaceId="ws-1" organizationId="org-1" />);

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
    render(<ChatboxesTab workspaceId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByText("Beta", {}, { timeout: 3000 }));

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Chatbox: sbx-2")).toBeInTheDocument();
    expect(screen.getByText("Workspace: ws-1")).toBeInTheDocument();
  });

  it("opens the starter launcher from the new chatbox action", async () => {
    render(<ChatboxesTab workspaceId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New chatbox" }));

    expect(
      await screen.findByText("What would you like to create?"),
    ).toBeInTheDocument();
  });

  it("starts a blank chatbox draft after choosing blank from the launcher", async () => {
    render(<ChatboxesTab workspaceId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New chatbox" }));
    fireEvent.click(await screen.findByText("Blank chatbox"));

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Chatbox: new")).toBeInTheDocument();
    expect(screen.getByText("Draft: New Chatbox")).toBeInTheDocument();
  });

  it("restores the saved builder session for the active workspace", async () => {
    writeBuilderSession({
      workspaceId: "ws-1",
      chatboxId: "sbx-2",
      draft: null,
      viewMode: "preview",
    });

    render(<ChatboxesTab workspaceId="ws-1" organizationId="org-1" />);

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Chatbox: sbx-2")).toBeInTheDocument();
    expect(screen.getByText("View mode: preview")).toBeInTheDocument();
  });

  it("returns to the chatbox index after leaving the builder", async () => {
    render(<ChatboxesTab workspaceId="ws-1" organizationId="org-1" />);

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
      workspacePremiumness: {
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
            upgradePlan: "starter",
            reason: "feature_not_included",
          },
        ],
      },
      isLoadingBilling: false,
      isLoadingWorkspacePremiumness: false,
    });

    render(<ChatboxesTab workspaceId="ws-1" organizationId="org-1" />);

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
      workspaceId: "ws-1",
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
      workspacePremiumness: {
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
            upgradePlan: "starter",
            reason: "feature_not_included",
          },
        ],
      },
      isLoadingBilling: false,
      isLoadingWorkspacePremiumness: false,
    });

    render(<ChatboxesTab workspaceId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("billing-upsell-gate"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(readBuilderSession("ws-1")).toBeNull();
    });
    expect(screen.queryByText("Builder view")).not.toBeInTheDocument();
  });

  it("shows an inline upgrade upsell when the workspace chatbox limit is reached", async () => {
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        plan: "starter",
        effectivePlan: "starter",
        canManageBilling: true,
      },
      planCatalog: createPlanCatalog(),
      workspacePremiumness: {
        plan: "starter",
        enforcementState: "active",
        effectivePlan: "starter",
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
            gateKey: "maxChatboxesPerWorkspace",
            kind: "limit",
            scope: "workspace",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "team",
            reason: "limit_reached",
            currentValue: 1,
            allowedValue: 1,
          },
        ],
      },
      isLoadingBilling: false,
      isLoadingWorkspacePremiumness: false,
    });

    render(<ChatboxesTab workspaceId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("chatbox-limit-upsell"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This workspace has reached its chatbox limit (1). Upgrade to continue.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Team includes 3 chatboxes per workspace and 100 members, from $296/mo (4-seat minimum).",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upgrade to Team" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chatbox" })).toBeDisabled();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("shows owner-directed chatbox upsell copy for non-billing-managers", async () => {
    mockUseOrganizationBilling.mockReturnValue({
      billingStatus: {
        plan: "starter",
        effectivePlan: "starter",
        canManageBilling: false,
      },
      planCatalog: createPlanCatalog(),
      workspacePremiumness: {
        plan: "starter",
        enforcementState: "active",
        effectivePlan: "starter",
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
            gateKey: "maxChatboxesPerWorkspace",
            kind: "limit",
            scope: "workspace",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "team",
            reason: "limit_reached",
            currentValue: 1,
            allowedValue: 1,
          },
        ],
      },
      isLoadingBilling: false,
      isLoadingWorkspacePremiumness: false,
    });

    render(<ChatboxesTab workspaceId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("chatbox-limit-upsell"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ask an organization owner to review billing options."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Team" }),
    ).not.toBeInTheDocument();
  });
});
