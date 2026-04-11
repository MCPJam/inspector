import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SandboxesTab } from "../SandboxesTab";
import { readBuilderSession, writeBuilderSession } from "@/lib/sandbox-session";

const mockBuilderViewProps = vi.fn();
const mockUseFeatureFlagEnabled = vi.fn(() => true);
const mockUseOrganizationBilling = vi.fn();

const sandboxList = [
  {
    sandboxId: "sbx-1",
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
    sandboxId: "sbx-2",
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
          sandboxes: false,
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
          maxSandboxesPerWorkspace: 0,
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
          sandboxes: true,
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
          maxSandboxesPerWorkspace: 1,
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
          sandboxes: true,
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
          maxSandboxesPerWorkspace: 3,
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
          sandboxes: true,
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
          maxSandboxesPerWorkspace: null,
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

vi.mock("@/hooks/useSandboxes", () => ({
  useSandboxList: () => ({
    sandboxes: sandboxList,
    isLoading: false,
  }),
  useSandboxMutations: () => ({
    createSandbox: vi.fn(),
    duplicateSandbox: vi.fn(),
    updateSandbox: vi.fn(),
    deleteSandbox: vi.fn(),
    setSandboxMode: vi.fn(),
    rotateSandboxLink: vi.fn(),
    upsertSandboxMember: vi.fn(),
    removeSandboxMember: vi.fn(),
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

vi.mock("../sandboxes/builder/SandboxBuilderView", () => ({
  SandboxBuilderView: (props: any) => {
    mockBuilderViewProps(props);

    return (
      <div>
        <h2>Builder view</h2>
        <p>Sandbox: {props.sandboxId ?? "new"}</p>
        <p>Draft: {props.draft?.name ?? "none"}</p>
        <p>Workspace: {props.workspaceName ?? "unknown"}</p>
        <p>View mode: {props.initialViewMode ?? "none"}</p>
        <button type="button" onClick={props.onBack}>
          Back to index
        </button>
      </div>
    );
  },
}));

describe("SandboxesTab", () => {
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
            gateKey: "sandboxes",
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
    render(<SandboxesTab workspaceId={null} organizationId={null} />);

    expect(
      screen.getByText("Select a workspace to manage sandboxes."),
    ).toBeInTheDocument();
  });

  it("shows a full-tab loading state while billing context is pending", () => {
    render(
      <SandboxesTab
        workspaceId="ws-1"
        organizationId="org-1"
        isBillingContextPending={true}
      />,
    );

    expect(
      screen.getByTestId("sandboxes-billing-context-pending"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sandboxes")).not.toBeInTheDocument();
  });

  it("renders the sandbox index once the builder experience loads", async () => {
    render(<SandboxesTab workspaceId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByRole(
        "heading",
        { name: "Sandboxes" },
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("opens the clicked sandbox in the builder view", async () => {
    render(<SandboxesTab workspaceId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByText("Beta", {}, { timeout: 3000 }));

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Sandbox: sbx-2")).toBeInTheDocument();
    expect(screen.getByText("Workspace: Workspace One")).toBeInTheDocument();
  });

  it("opens the starter launcher from the new sandbox action", async () => {
    render(<SandboxesTab workspaceId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New sandbox" }));

    expect(
      await screen.findByText("What would you like to create?"),
    ).toBeInTheDocument();
  });

  it("starts a blank sandbox draft after choosing blank from the launcher", async () => {
    render(<SandboxesTab workspaceId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New sandbox" }));
    fireEvent.click(await screen.findByText("Blank sandbox"));

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Sandbox: new")).toBeInTheDocument();
    expect(screen.getByText("Draft: New Sandbox")).toBeInTheDocument();
  });

  it("restores the saved builder session for the active workspace", async () => {
    writeBuilderSession({
      workspaceId: "ws-1",
      sandboxId: "sbx-2",
      draft: null,
      viewMode: "preview",
    });

    render(<SandboxesTab workspaceId="ws-1" organizationId="org-1" />);

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Sandbox: sbx-2")).toBeInTheDocument();
    expect(screen.getByText("View mode: preview")).toBeInTheDocument();
  });

  it("returns to the sandbox index after leaving the builder", async () => {
    render(<SandboxesTab workspaceId="ws-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New sandbox" }));
    fireEvent.click(await screen.findByText("Blank sandbox"));
    fireEvent.click(screen.getByRole("button", { name: "Back to index" }));

    expect(
      await screen.findByRole("heading", { name: "Sandboxes" }),
    ).toBeInTheDocument();
  });

  it("shows the upsell gate instead of opening the sandbox surface when sandboxes are denied", async () => {
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
            gateKey: "sandboxes",
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

    render(<SandboxesTab workspaceId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("billing-upsell-gate"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New sandbox" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Builder view")).not.toBeInTheDocument();
  });

  it("clears restored builder sessions when sandboxes are denied", async () => {
    writeBuilderSession({
      workspaceId: "ws-1",
      sandboxId: "sbx-2",
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
            gateKey: "sandboxes",
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

    render(<SandboxesTab workspaceId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("billing-upsell-gate"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(readBuilderSession("ws-1")).toBeNull();
    });
    expect(screen.queryByText("Builder view")).not.toBeInTheDocument();
  });

  it("shows an inline upgrade upsell when the workspace sandbox limit is reached", async () => {
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
            gateKey: "sandboxes",
            kind: "feature",
            scope: "organization",
            canAccess: true,
            shouldShowUpsell: false,
            upgradePlan: null,
            reason: "feature_included",
          },
          {
            gateKey: "maxSandboxesPerWorkspace",
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

    render(<SandboxesTab workspaceId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("sandbox-limit-upsell"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This workspace has reached its sandbox limit (1). Upgrade to continue.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Team includes 3 sandboxes per workspace and 100 members, from $296/mo (4-seat minimum).",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upgrade to Team" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New sandbox" })).toBeDisabled();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("shows owner-directed sandbox upsell copy for non-billing-managers", async () => {
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
            gateKey: "sandboxes",
            kind: "feature",
            scope: "organization",
            canAccess: true,
            shouldShowUpsell: false,
            upgradePlan: null,
            reason: "feature_included",
          },
          {
            gateKey: "maxSandboxesPerWorkspace",
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

    render(<SandboxesTab workspaceId="ws-1" organizationId="org-1" />);

    expect(
      await screen.findByTestId("sandbox-limit-upsell"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ask an organization owner to review billing options."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Team" }),
    ).not.toBeInTheDocument();
  });
});
