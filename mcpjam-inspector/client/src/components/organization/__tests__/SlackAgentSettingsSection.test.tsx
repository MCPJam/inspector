import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Slack org-settings section.
 *
 * What these pin, in order of how badly a regression would hurt:
 *
 *   1. THE FLAG GATES THE COMPONENT ITSELF, not just the tab strip. A user who
 *      types the URL must not reach a half-built surface.
 *   2. MEMBERS GET READ-ONLY. The backend refuses their writes, but a UI that
 *      offers controls the server will reject teaches people the app is
 *      broken.
 *   3. THE BINDING CONFLICT IS SURFACED. "That channel is already bound" is
 *      the one error an admin will actually hit, and swallowing it would leave
 *      them clicking a button that silently does nothing.
 *   4. THE CAPABILITY TOGGLES ROUND-TRIP as a whole list, grouped by tier, and
 *      never offer to PROMOTE a direct op to gated.
 *   5. ACTIVITY renders one row per action type, pages, and says so when empty.
 */

const flagMock = vi.fn();
const connectionsMock = vi.fn();
const capabilitiesMock = vi.fn();
const catalogMock = vi.fn();
const activityMock = vi.fn();
const projectsMock = vi.fn();

vi.mock("@/hooks/useSlackAgentSettingsEnabled", () => ({
  useSlackAgentSettingsEnabled: () => flagMock(),
  SLACK_AGENT_ORG_SETTINGS_FEATURE_FLAG: "slack-agent-org-settings",
}));

vi.mock("@/hooks/useOrgSlackSettings", () => ({
  useOrgSlackSettings: () => connectionsMock(),
  useOrgSlackCapabilities: () => capabilitiesMock(),
}));

vi.mock("@/hooks/useAgentOpCatalog", () => ({
  useAgentOpCatalog: () => catalogMock(),
  clearAgentOpCatalogCache: vi.fn(),
}));

vi.mock("@/hooks/useSlackAgentActivity", () => ({
  useSlackAgentActivity: () => activityMock(),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectQueries: () => projectsMock(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

import { SlackAgentSettingsSection } from "../slack/SlackAgentSettingsSection";

const SET_ORG_DEFAULT = vi.fn();
const CREATE_BINDING = vi.fn();
const REMOVE_BINDING = vi.fn();
const SET_DISABLED = vi.fn();
const LOAD_MORE = vi.fn();

function baseConnections(overrides: Record<string, unknown> = {}) {
  return {
    connections: {
      workspaces: [
        {
          surfaceKind: "slack" as const,
          surfaceTenantId: "T1",
          name: "Acme HQ",
          installed: true,
          linkedMemberCount: 3,
          defaultProjectId: null,
          configuredAt: null,
        },
      ],
      channelBindings: [
        {
          _id: "b1",
          surfaceKind: "slack" as const,
          surfaceTenantId: "T1",
          channelId: "C_PAYMENTS",
          projectId: "p1",
          createdAt: 1,
        },
      ],
    },
    isLoading: false,
    error: null,
    isSaving: false,
    setOrgDefaultProject: SET_ORG_DEFAULT,
    createChannelBinding: CREATE_BINDING,
    removeChannelBinding: REMOVE_BINDING,
    ...overrides,
  };
}

const CATALOG = [
  {
    name: "list_eval_suites",
    title: "List eval suites",
    description: "List the project's suites.",
    tier: "direct" as const,
    readOnly: true,
  },
  {
    name: "create_eval_suite",
    title: "Create eval suite",
    description: "Create a suite.",
    tier: "direct" as const,
    readOnly: false,
  },
  {
    name: "run_eval_suite",
    title: "Run eval suite",
    description: "Run a suite.",
    tier: "gated" as const,
    readOnly: false,
    gatedKind: "start",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  flagMock.mockReturnValue(true);
  connectionsMock.mockReturnValue(baseConnections());
  capabilitiesMock.mockReturnValue({
    disabledOperations: [],
    isLoading: false,
    error: null,
    isSaving: false,
    setDisabledOperations: SET_DISABLED,
  });
  catalogMock.mockReturnValue({
    operations: CATALOG,
    isLoading: false,
    error: null,
  });
  activityMock.mockReturnValue({
    events: [],
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    error: null,
    refresh: vi.fn(),
    loadMore: LOAD_MORE,
  });
  projectsMock.mockReturnValue({
    sortedProjects: [
      { _id: "p1", name: "Payments", updatedAt: 2 },
      { _id: "p2", name: "Checkout", updatedAt: 1 },
    ],
  });
});

describe("flag gating", () => {
  it("renders NOTHING when the flag is off", () => {
    // The tab strip hides the entry, but a typed URL bypasses the strip — so
    // the component has to enforce it too.
    flagMock.mockReturnValue(false);
    const { container } = render(
      <SlackAgentSettingsSection organizationId="org_1" isAdmin />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the section when the flag is on", () => {
    render(<SlackAgentSettingsSection organizationId="org_1" isAdmin />);
    expect(screen.getByTestId("slack-agent-settings")).toBeInTheDocument();
  });
});

describe("Connections tab", () => {
  it("lists the org's workspaces and its bindings", () => {
    render(<SlackAgentSettingsSection organizationId="org_1" isAdmin />);
    expect(screen.getByTestId("slack-workspace-T1")).toHaveTextContent(
      "Acme HQ"
    );
    expect(screen.getByTestId("slack-workspace-T1")).toHaveTextContent(
      "3 connected members"
    );
    // The binding table resolves the project id to a name the admin recognises.
    expect(screen.getByTestId("slack-binding-C_PAYMENTS")).toHaveTextContent(
      "Payments"
    );
  });

  it("says so when the app is not installed in a workspace the org uses", () => {
    // The state that explains "why doesn't the bot answer us" — worth its own
    // sentence rather than an empty row.
    connectionsMock.mockReturnValue(
      baseConnections({
        connections: {
          workspaces: [
            {
              surfaceKind: "slack" as const,
              surfaceTenantId: "T1",
              name: "Acme HQ",
              installed: false,
              linkedMemberCount: 1,
              defaultProjectId: null,
              configuredAt: null,
            },
          ],
          channelBindings: [],
        },
      })
    );
    render(<SlackAgentSettingsSection organizationId="org_1" isAdmin />);
    expect(screen.getByTestId("slack-workspace-T1")).toHaveTextContent(
      "MCPJam is not installed"
    );
  });

  it("states the precedence rule next to the control", () => {
    // Two defaults invites the wrong assumption; the copy corrects it where
    // the decision is made rather than in docs nobody opens.
    render(<SlackAgentSettingsSection organizationId="org_1" isAdmin />);
    expect(
      screen.getByText(/never overrides an individual/i)
    ).toBeInTheDocument();
  });

  it("gives a MEMBER a read-only view", () => {
    render(
      <SlackAgentSettingsSection organizationId="org_1" isAdmin={false} />
    );
    // No remove control and no add form: the backend refuses these writes, and
    // offering them would teach members the app is broken.
    expect(
      screen.queryByLabelText("Remove binding for C_PAYMENTS")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Bind channel" })
    ).not.toBeInTheDocument();
  });

  it("removes a binding through the hook", async () => {
    REMOVE_BINDING.mockResolvedValue(undefined);
    render(<SlackAgentSettingsSection organizationId="org_1" isAdmin />);
    fireEvent.click(screen.getByLabelText("Remove binding for C_PAYMENTS"));
    await waitFor(() => expect(REMOVE_BINDING).toHaveBeenCalledWith("b1"));
  });

  it("SURFACES the already-bound conflict", () => {
    // The one error an admin will actually hit. Swallowing it would leave them
    // clicking a button that silently does nothing.
    connectionsMock.mockReturnValue(
      baseConnections({ error: "That channel is already bound to a project" })
    );
    render(<SlackAgentSettingsSection organizationId="org_1" isAdmin />);
    expect(screen.getByRole("alert")).toHaveTextContent("already bound");
  });

  it("shows an empty state instead of a bare table", () => {
    connectionsMock.mockReturnValue(
      baseConnections({
        connections: { workspaces: [], channelBindings: [] },
      })
    );
    render(<SlackAgentSettingsSection organizationId="org_1" isAdmin />);
    expect(screen.getByText(/No Slack workspaces yet/i)).toBeInTheDocument();
  });
});

describe("Capabilities tab", () => {
  function renderCapabilities(isAdmin = true) {
    render(
      <SlackAgentSettingsSection
        organizationId="org_1"
        isAdmin={isAdmin}
        tab="capabilities"
      />
    );
  }

  it("groups the registry by tier", () => {
    renderCapabilities();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    // The gated group's heading and its per-row badge share this label.
    expect(screen.getAllByText("Requires approval").length).toBeGreaterThan(1);
    expect(screen.getByTestId("agent-op-run_eval_suite")).toBeInTheDocument();
  });

  it("offers NO promotion control for a direct op", () => {
    // Disable-only in this release. A control that looked like it escalated a
    // direct op to gated would be a lie — that needs authored approval copy
    // per operation.
    renderCapabilities();
    const direct = screen.getByTestId("agent-op-create_eval_suite");
    expect(direct).not.toHaveTextContent("Requires approval");
  });

  it("saves the WHOLE disabled list when a toggle flips", async () => {
    SET_DISABLED.mockResolvedValue(undefined);
    renderCapabilities();
    fireEvent.click(screen.getByLabelText("Enable run_eval_suite"));
    await waitFor(() =>
      expect(SET_DISABLED).toHaveBeenCalledWith(["run_eval_suite"])
    );
  });

  it("re-enables by REMOVING the name from the list", async () => {
    capabilitiesMock.mockReturnValue({
      disabledOperations: ["run_eval_suite", "create_eval_suite"],
      isLoading: false,
      error: null,
      isSaving: false,
      setDisabledOperations: SET_DISABLED,
    });
    SET_DISABLED.mockResolvedValue(undefined);
    renderCapabilities();
    fireEvent.click(screen.getByLabelText("Enable run_eval_suite"));
    await waitFor(() =>
      expect(SET_DISABLED).toHaveBeenCalledWith(["create_eval_suite"])
    );
  });

  it("does not save while the policy is still loading", () => {
    // The catalog is cached for the page's lifetime and the policy is not, so
    // this window is real. A click here would compute a whole-list replacement
    // from an empty set and re-enable everything the org had disabled.
    capabilitiesMock.mockReturnValue({
      disabledOperations: undefined,
      isLoading: true,
      error: null,
      isSaving: false,
      setDisabledOperations: SET_DISABLED,
    });
    renderCapabilities();
    const toggle = screen.getByLabelText("Enable run_eval_suite");
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(SET_DISABLED).not.toHaveBeenCalled();
  });

  it("is read-only for a non-admin", () => {
    renderCapabilities(false);
    expect(screen.getByLabelText("Enable run_eval_suite")).toBeDisabled();
    expect(
      screen.getByText(/Only organization admins can change these/i)
    ).toBeInTheDocument();
  });

  it("says the change takes effect within a minute", () => {
    // The enforcement caches are 60s; promising anything faster would be a lie.
    renderCapabilities();
    expect(
      screen.getByText(/take effect within a minute/i)
    ).toBeInTheDocument();
  });

  it("reports a catalog failure rather than rendering an empty list", () => {
    // An empty list reads as "your org has no agent tools", which would send
    // an admin looking for the wrong problem.
    catalogMock.mockReturnValue({
      operations: undefined,
      isLoading: false,
      error: "agent-ops 500",
    });
    renderCapabilities();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Could not load the agent's tool list/i
    );
  });
});

describe("Activity tab", () => {
  function renderActivity() {
    render(
      <SlackAgentSettingsSection
        organizationId="org_1"
        isAdmin
        tab="activity"
      />
    );
  }

  it("shows an empty state", () => {
    renderActivity();
    expect(screen.getByText(/Nothing yet/i)).toBeInTheDocument();
  });

  it("renders a row per action type, with the approver and the run link", () => {
    activityMock.mockReturnValue({
      events: [
        {
          _id: "e2",
          action: "slack.agent.proposal_executed",
          actorType: "user",
          actorId: "u1",
          actorEmail: "approver@test.local",
          organizationId: "org_1",
          projectId: "p1",
          targetType: "agentProposal",
          targetId: "act_1",
          metadata: {
            operation: "run_eval_suite",
            status: "succeeded",
            proposerSurfaceUserId: "U_PROPOSER",
            executorSurfaceUserId: "U_APPROVER",
            resourceUrl: "https://mcpjam.test/evals/suite/s/runs/run_1",
          },
          timestamp: 2,
        },
        {
          _id: "e1",
          action: "slack.agent.proposal_created",
          actorType: "system",
          actorId: null,
          actorEmail: null,
          organizationId: "org_1",
          projectId: "p1",
          targetType: "agentProposal",
          targetId: "act_1",
          metadata: {
            operation: "run_eval_suite",
            proposerSurfaceUserId: "U_PROPOSER",
          },
          timestamp: 1,
        },
      ],
      isLoading: false,
      isLoadingMore: false,
      hasMore: false,
      error: null,
      refresh: vi.fn(),
      loadMore: LOAD_MORE,
    });
    renderActivity();

    const executed = screen.getByTestId(
      "activity-slack.agent.proposal_executed"
    );
    expect(executed).toHaveTextContent("Approved & ran");
    expect(executed).toHaveTextContent("approver@test.local");
    // Proposer ≠ approver is the whole point of the record.
    expect(executed).toHaveTextContent("proposed by Slack U_PROPOSER");
    expect(executed).toHaveTextContent("Succeeded");
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "https://mcpjam.test/evals/suite/s/runs/run_1"
    );

    // An unlinked proposer has no email; the Slack id is shown instead of a
    // blank cell.
    const created = screen.getByTestId("activity-slack.agent.proposal_created");
    expect(created).toHaveTextContent("Slack U_PROPOSER");
  });

  it("marks a failed execution", () => {
    activityMock.mockReturnValue({
      events: [
        {
          _id: "e3",
          action: "slack.agent.proposal_executed",
          actorType: "user",
          actorId: "u1",
          actorEmail: "approver@test.local",
          organizationId: "org_1",
          projectId: "p1",
          targetType: "agentProposal",
          targetId: "act_2",
          metadata: { operation: "run_eval_suite", status: "failed" },
          timestamp: 3,
        },
      ],
      isLoading: false,
      isLoadingMore: false,
      hasMore: false,
      error: null,
      refresh: vi.fn(),
      loadMore: LOAD_MORE,
    });
    renderActivity();
    expect(
      screen.getByTestId("activity-slack.agent.proposal_executed")
    ).toHaveTextContent("Failed");
  });

  it("loads more when there is more", () => {
    activityMock.mockReturnValue({
      events: [
        {
          _id: "e1",
          action: "slack.agent.channel_binding_created",
          actorType: "user",
          actorId: "u1",
          actorEmail: "admin@test.local",
          organizationId: "org_1",
          projectId: "p1",
          targetType: "surfaceChannelBinding",
          targetId: "b1",
          metadata: { channelId: "C1" },
          timestamp: 1,
        },
      ],
      isLoading: false,
      isLoadingMore: false,
      hasMore: true,
      error: null,
      refresh: vi.fn(),
      loadMore: LOAD_MORE,
    });
    renderActivity();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(LOAD_MORE).toHaveBeenCalled();
  });
});
