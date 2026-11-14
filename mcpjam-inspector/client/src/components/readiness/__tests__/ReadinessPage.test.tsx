/**
 * The /readiness route: behind `mcpjam-directory-readiness`, then the
 * portal's first screen for a saved server, then the form rendered from the
 * flow with MCPJam's results under the answers they read.
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  placeDirectoryResults,
  type DirectoryAnswer,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import { ReadinessPage, ReadinessRoute } from "../ReadinessPage";

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
});

describe("ReadinessPage", () => {
  const SERVERS = [
    {
      id: "srv_1",
      server: {
        name: "Sample server",
        config: { url: "https://mcp.example.com/mcp" },
        connectionStatus: "disconnected",
      },
    },
    {
      id: "srv_2",
      server: {
        name: "Other server",
        config: { url: "https://other.example.com/mcp" },
        connectionStatus: "disconnected",
      },
    },
  ] as unknown as Parameters<typeof ReadinessPage>[0]["servers"];

  const page = (selected: string, onSelect = vi.fn()) => (
    <ReadinessPage
      projectId="proj_1"
      servers={SERVERS}
      selected={selected}
      onSelect={onSelect}
    />
  );

  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    api.getDirectoryFlow.mockResolvedValue(CLAUDE_CONNECTOR_FLOW);
    api.listServerSubmissions.mockResolvedValue([]);
    api.createDirectorySubmission.mockResolvedValue(submission());
    api.getDirectorySubmission.mockResolvedValue(submission());
    api.startDirectorySubmissionRun.mockResolvedValue({
      runId: "run_2",
      status: "pending",
    });
  });

  /** Opens the rehearsal and types into the Listing step's Name. */
  async function editName() {
    await userEvent.click(
      screen.getByRole("button", { name: /MCP connector/ }),
    );
    await screen.findByRole("heading", { level: 1, name: "Connection" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(screen.getByLabelText(/^Name/), " 2");
  }

  /** Picks a server in the rehearsal bar's picker. */
  async function chooseServer(name: string) {
    await userEvent.click(screen.getByRole("button", { name: "Server" }));
    const rows = within(screen.getByRole("dialog")).getAllByRole("button", {
      name: new RegExp(`${name}$`),
    });
    await userEvent.click(
      rows.find(
        (row) => !row.getAttribute("aria-label")?.startsWith("Connect"),
      )!,
    );
  }

  it("starts over on another server while a rehearsal is being created", async () => {
    let finish: (view: SubmissionView) => void = () => undefined;
    api.createDirectorySubmission.mockReturnValue(
      new Promise<SubmissionView>((resolve) => (finish = resolve)),
    );
    const { rerender } = render(page("Sample server"));
    await userEvent.click(
      screen.getByRole("button", { name: /MCP connector/ }),
    );
    expect(
      screen.getByRole("button", { name: /MCP connector/ }),
    ).toBeDisabled();

    rerender(page("Other server"));
    expect(screen.getByRole("button", { name: /MCP connector/ })).toBeEnabled();
    expect(api.listServerSubmissions).toHaveBeenLastCalledWith(
      "proj_1",
      "srv_2",
      expect.any(AbortSignal),
    );

    // The first server's rehearsal is not opened when it arrives late.
    await act(async () => finish({ ...submission(), id: "sub_9" }));
    rerender(page("Sample server"));
    expect(screen.getByText("What would you like to submit?")).toBeVisible();
    expect(api.getDirectorySubmission).not.toHaveBeenCalled();
  });

  it("starts one run when Run checks is pressed twice during the save", async () => {
    let finish: (view: SubmissionView) => void = () => undefined;
    api.updateDirectorySubmission.mockReturnValue(
      new Promise<SubmissionView>((resolve) => (finish = resolve)),
    );
    render(page("Sample server"));
    await editName();

    const run = screen.getByRole("button", { name: /Run checks/ });
    await userEvent.click(run);
    await userEvent.click(run);
    await act(async () => finish({ ...submission(), revision: 3 }));

    expect(api.updateDirectorySubmission).toHaveBeenCalledTimes(1);
    expect(api.startDirectorySubmissionRun).toHaveBeenCalledTimes(1);
  });

  it.each(["Save and exit", "Submissions"])(
    "keeps the form open when %s cannot save",
    async (button) => {
      api.updateDirectorySubmission.mockRejectedValue(
        new Error("The name is too long."),
      );
      render(page("Sample server"));
      await editName();

      await userEvent.click(screen.getByRole("button", { name: button }));
      expect(
        screen.getByRole("heading", { level: 1, name: "Listing" }),
      ).toBeVisible();
      expect(
        screen.getByText(
          /Your last change was not saved\. The name is too long\./,
        ),
      ).toBeVisible();
    },
  );

  it("keeps the rehearsal open, on its server, when another server is chosen and the save fails", async () => {
    api.updateDirectorySubmission.mockRejectedValue(
      new Error("The name is too long."),
    );
    const onSelect = vi.fn();
    render(page("Sample server", onSelect));
    await editName();

    await chooseServer("Other server");
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        /Your last change was not saved\. The name is too long\./,
      ),
    ).toBeVisible();

    api.updateDirectorySubmission.mockResolvedValue({
      ...submission(),
      revision: 3,
    });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await chooseServer("Other server");
    expect(onSelect).toHaveBeenCalledWith("Other server");
  });

  it("closes the form once Save and exit has saved", async () => {
    api.updateDirectorySubmission.mockResolvedValue({
      ...submission(),
      revision: 3,
    });
    render(page("Sample server"));
    await editName();

    await userEvent.click(
      screen.getByRole("button", { name: "Save and exit" }),
    );
    expect(api.updateDirectorySubmission).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("What would you like to submit?"),
    ).toBeVisible();
  });
});
