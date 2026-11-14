/**
 * The /readiness route: behind `mcpjam-directory-readiness`, then the
 * portal's first screen for a saved server, then the form rendered from the
 * flow with MCPJam's results under the answers they read.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  draftDirectoryTestPlan,
  placeDirectoryResults,
  type DirectoryAnswer,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import { ReadinessRoute } from "../ReadinessPage";

const flag = vi.hoisted(() => ({ value: undefined as boolean | undefined }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (key: string) =>
    key === "mcpjam-directory-readiness" ? flag.value : undefined,
}));

const context = vi.hoisted(() => ({
  convexProjectId: "proj_1" as string | null,
  isAuthenticated: true,
  displayServerConfigs: {
    "Sample server": {
      name: "Sample server",
      config: { url: "https://mcp.example.com/mcp" },
      connectionStatus: "disconnected",
    },
  },
  selectedServerEntry: { name: "Sample server" } as { name: string } | null,
  setSelectedServer: vi.fn(),
}));
vi.mock("@/lib/app-route-context", () => ({
  useAppRouteContext: () => context,
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({
    serversByName: new Map([["Sample server", "srv_1"]]),
    isLoading: false,
  }),
}));
vi.mock("@/components/routing/scoped-navigate", () => ({
  ScopedNavigate: ({ to }: { to: string }) => (
    <div data-testid="navigate" data-to={to} />
  ),
}));

const api = vi.hoisted(() => ({
  getDirectoryFlow: vi.fn(),
  listServerSubmissions: vi.fn(),
  createDirectorySubmission: vi.fn(),
  getDirectorySubmission: vi.fn(),
  updateDirectorySubmission: vi.fn(),
  startDirectorySubmissionRun: vi.fn(),
}));
vi.mock("@/lib/apis/directory-submissions-api", () => api);

const plans = vi.hoisted(() => ({
  getTestPlan: vi.fn(),
  draftTestPlan: vi.fn(),
  saveTestPlan: vi.fn(),
  getToolTests: vi.fn(),
}));
vi.mock("@/lib/apis/directory-test-plan-api", () => plans);
vi.mock("@/hooks/use-task-owner-id", () => ({
  useTaskOwnerId: () => "user_1",
}));

function finding(
  id: string,
  status: "violated" | "satisfied",
  remediation?: string,
): PlacedFinding["finding"] {
  return {
    id,
    title:
      id === "claude.endpoint.https"
        ? "The server URL uses https"
        : "Listing fields follow the portal's rules",
    lane: "submission-artifacts",
    class: "required",
    status,
    remediation,
    source: {},
    provenance: id === "claude.endpoint.https" ? "wire" : "declared",
    intrusiveness: "passive",
    evaluatedAt: "2026-01-01T00:00:00.000Z",
    engineVersion: "test",
  };
}

function submission(): SubmissionView {
  const answers: DirectoryAnswer[] = [
    { key: "listing.name", value: "Sample server", origin: "set", revision: 2 },
  ];
  return {
    id: "sub_1",
    projectId: "proj_1",
    serverId: "srv_1",
    directory: "claude",
    flowId: "claude-connector",
    flowVersion: CLAUDE_CONNECTOR_FLOW.version,
    answers,
    revision: 2,
    createdBy: "user_1",
    createdAt: 1,
    updatedAt: 2,
    fieldIssues: [],
    steps: placeDirectoryResults({
      flow: CLAUDE_CONNECTOR_FLOW,
      answers,
      findings: [
        finding("claude.endpoint.https", "satisfied"),
        finding(
          "claude.submission.listing-fields",
          "violated",
          "Add a one-liner of 200 characters or fewer.",
        ),
      ],
    }),
    resultsRunId: "run_1",
    submissionUrl: CLAUDE_CONNECTOR_FLOW.submissionUrl,
  };
}

describe("ReadinessRoute", () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    for (const mock of Object.values(plans)) mock.mockReset();
    plans.getTestPlan.mockResolvedValue(null);
    plans.getToolTests.mockResolvedValue({ run: null, tools: [], inDoubt: [] });
    api.getDirectoryFlow.mockResolvedValue(CLAUDE_CONNECTOR_FLOW);
    api.listServerSubmissions.mockResolvedValue([]);
    api.createDirectorySubmission.mockResolvedValue(submission());
    api.getDirectorySubmission.mockResolvedValue(submission());
    context.convexProjectId = "proj_1";
    context.selectedServerEntry = { name: "Sample server" };
    flag.value = true;
  });

  it("sends a user without the flag back to Servers", () => {
    flag.value = false;
    render(<ReadinessRoute />);
    expect(screen.getByTestId("navigate")).toHaveAttribute(
      "data-to",
      "/servers",
    );
  });

  it("renders nothing while the flag is still loading", () => {
    flag.value = undefined;
    const { container } = render(<ReadinessRoute />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("navigate")).toBeNull();
  });

  it("says it is a rehearsal and opens on the portal's first screen", async () => {
    api.listServerSubmissions.mockResolvedValue([
      { ...submission(), id: "sub_0", updatedAt: Date.now() },
    ]);
    render(<ReadinessRoute />);
    expect(screen.getByText("Rehearsal")).toBeVisible();
    expect(
      screen.getByText(
        "A copy of the Claude portal. Nothing here is sent to Claude.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Run checks" })).toBeDisabled();
    expect(screen.getByText("What would you like to submit?")).toBeVisible();
    expect(
      screen.getByText("MCPJam: rehearsal not available yet"),
    ).toBeVisible();
    expect(
      await screen.findByText("Saved rehearsals for this server"),
    ).toBeVisible();
    expect(api.listServerSubmissions).toHaveBeenCalledWith(
      "proj_1",
      "srv_1",
      expect.any(AbortSignal),
    );
  });

  describe("confirming a test plan revision before a run uses it", () => {
    const KEY = "mcpjam-readiness-test-plan-confirmed:proj_1:sub_1";
    const plan = (revision: number) => ({
      submissionId: "sub_1",
      revision,
      counts: { tools: 3, cases: 3, fixtures: 0, cleanup: 0 },
      savedBy: "user_2",
      savedAt: Date.now() - 3_600_000,
      plan: draftDirectoryTestPlan([
        { name: "search_docs", annotations: { readOnlyHint: true } },
        { name: "create_note", annotations: { destructiveHint: false } },
        { name: "delete_note" },
      ]),
      issues: [],
      catalog: null,
    });
    const sentRevisions = () =>
      api.startDirectorySubmissionRun.mock.calls.map((call) => call[3]);

    /** Opens the rehearsal and presses the run button once it reads `label`. */
    async function pressRun(label: string) {
      const page = render(<ReadinessRoute />);
      await userEvent.click(
        screen.getByRole("button", { name: /MCP connector/ }),
      );
      const button = await screen.findByRole("button", { name: label });
      await waitFor(() => expect(button).toBeEnabled());
      await userEvent.click(button);
      return page;
    }

    beforeEach(() => {
      window.localStorage.clear();
      api.startDirectorySubmissionRun.mockResolvedValue({ runId: "run_2" });
      plans.getTestPlan.mockResolvedValue(plan(3));
    });

    it("asks before a run uses a revision this browser has not confirmed, and Cancel starts nothing", async () => {
      await pressRun("Run checks with test plan revision 3");
      const dialog = screen.getByRole("alertdialog", {
        name: "Run checks with test plan revision 3?",
      });
      expect(dialog).toHaveTextContent(
        "Revision 3 was saved by a project member about 1 hour ago. It calls 3 tools on Sample server with your account.",
      );
      expect(dialog).toHaveTextContent("create_note can change data.");
      expect(dialog).toHaveTextContent("delete_note can destroy data.");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(api.startDirectorySubmissionRun).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(KEY)).toBeNull();
    });

    it("starts the run with the revision confirmed, and does not ask for it again", async () => {
      const first = await pressRun("Run checks with test plan revision 3");
      await userEvent.click(
        screen.getByRole("button", { name: "Run with revision 3" }),
      );
      await waitFor(() => expect(sentRevisions()).toEqual([3]));
      expect(api.startDirectorySubmissionRun).toHaveBeenCalledWith(
        { projectId: "proj_1", submissionId: "sub_1" },
        expect.any(String),
        undefined,
        3,
      );
      first.unmount();
      await pressRun("Run checks with test plan revision 3");
      expect(screen.queryByRole("alertdialog")).toBeNull();
      await waitFor(() => expect(sentRevisions()).toEqual([3, 3]));
    });

    it("asks again for a newer revision", async () => {
      window.localStorage.setItem(KEY, "3");
      plans.getTestPlan.mockResolvedValue(plan(4));
      await pressRun("Run checks with test plan revision 4");
      expect(
        screen.getByRole("alertdialog", {
          name: "Run checks with test plan revision 4?",
        }),
      ).toBeVisible();
      expect(api.startDirectorySubmissionRun).not.toHaveBeenCalled();
    });

    it("asks every time when storage is unavailable", async () => {
      const blocked = (key: string) => {
        if (key === KEY) throw new Error("Storage is blocked");
        return null;
      };
      vi.spyOn(window.localStorage, "getItem").mockImplementation(blocked);
      vi.spyOn(window.localStorage, "setItem").mockImplementation(blocked);
      const first = await pressRun("Run checks with test plan revision 3");
      await userEvent.click(
        screen.getByRole("button", { name: "Run with revision 3" }),
      );
      await waitFor(() => expect(sentRevisions()).toEqual([3]));
      first.unmount();
      await pressRun("Run checks with test plan revision 3");
      expect(screen.getByRole("alertdialog")).toBeVisible();
      expect(sentRevisions()).toEqual([3]);
    });

    it("sends no revision and asks nothing when no plan is saved", async () => {
      plans.getTestPlan.mockResolvedValue(null);
      render(<ReadinessRoute />);
      await userEvent.click(
        screen.getByRole("button", { name: /MCP connector/ }),
      );
      await waitFor(() => expect(plans.getTestPlan).toHaveBeenCalled());
      const button = await screen.findByRole("button", { name: "Run checks" });
      await waitFor(() => expect(button).toBeEnabled());
      await userEvent.click(button);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      await waitFor(() => expect(sentRevisions()).toEqual([undefined]));
    });
  });

  it("shows the test plan on Test & launch, marked as MCPJam's", async () => {
    render(<ReadinessRoute />);
    await userEvent.click(
      screen.getByRole("button", { name: /MCP connector/ }),
    );
    const rail = within(
      await screen.findByRole("navigation", {
        name: "Claude submission steps",
      }),
    );
    expect(
      screen.queryByRole("region", { name: "MCPJam test plan" }),
    ).toBeNull();
    await userEvent.click(rail.getByRole("button", { name: /Test & launch/ }));
    const section = screen.getByRole("region", { name: "MCPJam test plan" });
    expect(
      await within(section).findByText(/^No test plan is saved/),
    ).toBeVisible();
    expect(plans.getToolTests).toHaveBeenCalled();
  });

  it("asks for a saved server first", () => {
    context.selectedServerEntry = null;
    render(<ReadinessRoute />);
    expect(
      screen.getByText("Choose a saved server to rehearse its submission."),
    ).toBeVisible();
  });

  it("starts a connector rehearsal and renders the Listing step from the flow", async () => {
    render(<ReadinessRoute />);
    await userEvent.click(
      screen.getByRole("button", { name: /MCP connector/ }),
    );
    expect(api.createDirectorySubmission).toHaveBeenCalledWith(
      { projectId: "proj_1", serverId: "srv_1", flowId: "claude-connector" },
      expect.stringMatching(/^ui-srv_1-/),
    );

    // Step 1: the result for the server URL sits under that field.
    expect(
      await screen.findByRole("heading", { level: 1, name: "Connection" }),
    ).toBeVisible();
    expect(screen.getByText("The server URL uses https")).toBeVisible();
    expect(screen.getByText(/Rules as of Nov 13, 2026/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Listing" }),
    ).toBeVisible();
    expect(
      screen.getByText("Submit an MCP connector · Step 3 of 10"),
    ).toBeVisible();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Sample server");
    expect(screen.getByLabelText(/One-liner/)).toHaveAttribute(
      "placeholder",
      "A short tagline for your MCP server",
    );
    expect(
      screen.getByText("Add a one-liner of 200 characters or fewer."),
    ).toBeVisible();
    expect(screen.getByText("1 blocker")).toBeVisible();
  });

  it("ends on the portal's review page, with copy where the portal submits", async () => {
    render(<ReadinessRoute />);
    await userEvent.click(
      screen.getByRole("button", { name: /MCP connector/ }),
    );
    await screen.findByRole("heading", { level: 1, name: "Connection" });
    const rail = within(
      screen.getByRole("navigation", { name: "Claude submission steps" }),
    );
    // A step is marked once left; the review page marks them all.
    expect(rail.queryByText("to fix")).toBeNull();
    await userEvent.click(rail.getByRole("button", { name: /Review/ }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Review and submit" }),
    ).toBeVisible();

    // The rail counts seven missing listing answers and the blocker; the
    // review page counts the seven and the author, which only it asks for.
    expect(rail.getByRole("button", { name: /Listing/ })).toHaveTextContent(
      "8 to fix",
    );
    const listing = screen.getByRole("button", { name: "Edit Listing" })
      .parentElement?.parentElement;
    if (!listing) throw new Error("No Listing section");
    expect(within(listing).getByText("8 fields to fix")).toBeVisible();
    expect(within(listing).getByText("MCPJam · 1 blocker")).toBeVisible();
    expect(
      within(listing).getByText(/^Error: An author is required/),
    ).toBeVisible();

    expect(
      screen.getByRole("button", { name: "Copy for the portal" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Open the real Claude portal/ }),
    ).toHaveAttribute("href", CLAUDE_CONNECTOR_FLOW.submissionUrl);
    expect(
      screen.getByText(
        "Some steps are missing required fields — submit to highlight them.",
      ),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Edit Listing" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Listing" }),
    ).toBeVisible();
    expect(screen.getByText("Error: Slug is required")).toBeVisible();
  });
});
