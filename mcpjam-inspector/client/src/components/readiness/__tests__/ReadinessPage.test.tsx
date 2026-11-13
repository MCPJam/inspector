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
  placeDirectoryResults,
  withDirectoryFlowDefaults,
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
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({
    members: [{ userId: "user_pm", user: { name: "Sample Person" } }],
  }),
}));
vi.mock("@/hooks/use-task-owner-id", () => ({
  useTaskOwnerId: () => "user_1",
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

const TITLES: Record<string, string> = {
  "claude.endpoint.https": "The server URL uses https",
  "claude.submission.listing-fields":
    "Listing fields follow the portal's rules",
  "claude.submission.access-matches-annotations":
    "The read or write declaration matches the tool annotations",
  "claude.submission.use-cases": "Each use case has an example prompt",
};

function finding(
  id: string,
  status: "violated" | "satisfied",
  remediation?: string,
): PlacedFinding["finding"] {
  return {
    id,
    title: TITLES[id] ?? id,
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

function submission(extra: PlacedFinding["finding"][] = []): SubmissionView {
  // As the API reads it: stored answers plus the portal's defaults.
  const answers: DirectoryAnswer[] = withDirectoryFlowDefaults(
    CLAUDE_CONNECTOR_FLOW,
    [
      {
        key: "listing.name",
        value: "Sample server",
        origin: "set",
        revision: 2,
      },
    ],
  );
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
        ...extra,
      ],
    }),
    resultsRunId: "run_1",
    submissionUrl: CLAUDE_CONNECTOR_FLOW.submissionUrl,
  };
}

describe("ReadinessRoute", () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    api.getDirectoryFlow.mockResolvedValue(CLAUDE_CONNECTOR_FLOW);
    api.listServerSubmissions.mockResolvedValue([]);
    api.createDirectorySubmission.mockResolvedValue(submission());
    api.getDirectorySubmission.mockResolvedValue(submission());
    api.updateDirectorySubmission.mockResolvedValue(submission());
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

  it("renders Use cases from the flow, with marks and results under the answers they read", async () => {
    const useCases = submission([
      finding(
        "claude.submission.access-matches-annotations",
        "violated",
        "Choose Read and write: 64 tools write.",
      ),
      finding("claude.submission.use-cases", "satisfied"),
    ]);
    api.createDirectorySubmission.mockResolvedValue(useCases);
    api.getDirectorySubmission.mockResolvedValue(useCases);
    render(<ReadinessRoute />);
    await userEvent.click(
      screen.getByRole("button", { name: /MCP connector/ }),
    );
    await screen.findByRole("heading", { level: 1, name: "Connection" });
    const rail = within(
      screen.getByRole("navigation", { name: "Claude submission steps" }),
    );
    await userEvent.click(rail.getByRole("button", { name: /Use cases/ }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Use cases" }),
    ).toBeVisible();

    // The portal's three rows of use case and example prompt.
    expect(screen.getByText("Example prompt")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Use case 3" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Use case 4" })).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Example prompt 1" }),
    ).toHaveAttribute(
      "placeholder",
      "What sizes are in stock at the Portland store?",
    );
    expect(screen.getByLabelText(/^Prerequisites/)).toBeVisible();
    expect(screen.getByRole("radio", { name: /Read only/ })).toBeChecked();
    const note = screen.getByText(
      "Based on what your tools do; we check it against their annotations.",
    );

    // The default is called out under the field, above the check that reads it.
    const mark = screen.getByText("Nobody has confirmed this answer.");
    const check = screen.getByText(
      "The read or write declaration matches the tool annotations",
    );
    expect(note.compareDocumentPosition(mark)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(mark.compareDocumentPosition(check)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      screen.getByText("Each use case has an example prompt"),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(
      () =>
        expect(api.updateDirectorySubmission).toHaveBeenCalledWith(
          { projectId: "proj_1", submissionId: "sub_1" },
          {
            expectedRevision: 2,
            answers: { "useCases.access": "read-only" },
            confirm: ["useCases.access"],
          },
        ),
      { timeout: 3000 },
    );
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
