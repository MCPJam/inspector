/**
 * The /readiness route: behind `mcpjam-directory-readiness`, then the
 * portal's first screen for a saved server, then the form rendered from the
 * flow with MCPJam's results under the answers they read.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_PLUGIN_FLOW,
  CLAUDE_CONNECTOR_FLOW,
  buildDirectoryHandoff,
  draftDirectoryTestPlan,
  placeDirectoryResults,
  withDirectoryFlowDefaults,
  type DirectoryAnswer,
  type DirectoryTestPlan,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import { ReadinessPage, ReadinessRoute } from "../ReadinessPage";

function renderRoute(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/readiness${search}`]}>
      <ReadinessRoute />
    </MemoryRouter>,
  );
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

const flag = vi.hoisted(() => ({ plugins: true, value: undefined as boolean | undefined }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (key: string) =>
    key === "plugins-enabled" ? true : key === "mcpjam-directory-readiness" ? flag.value : undefined,
}));

const context = vi.hoisted(() => ({
  convexProjectId: "proj_1" as string | null,
  isAuthenticated: true,
  displayServerConfigs: {
    "Other server": {
      name: "Other server",
      config: { url: new URL("https://other.example.com/mcp") },
      connectionStatus: "disconnected",
    },
    "Sample server": {
      name: "Sample server",
      config: { url: new URL("https://mcp.example.com/mcp") },
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
    serversByName: new Map([["Sample server", "srv_1"], ["Other server", "srv_2"]]),
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
  getDirectorySubmissionHandoff: vi.fn(),
  exportDirectorySubmission: vi.fn(),
  getSubmissionFinding: vi.fn(),
  listSubmissionEvents: vi.fn(),
  recordSubmissionEvent: vi.fn(),
}));
vi.mock("@/lib/apis/directory-submissions-api", () => api);
vi.mock("@/components/plugins/AddPluginModal", () => ({
  AddPluginModal: ({ isOpen, onInstalled }: {
    isOpen: boolean;
    onInstalled: (result: { pluginId: string; pluginVersionId: string }) => void;
  }) => isOpen ? (
    <button onClick={() => onInstalled({ pluginId: "plugin_one", pluginVersionId: "imported_version" })}>
      Finish test import
    </button>
  ) : null,
}));
vi.mock("@/hooks/usePluginImportApi", () => ({
  useProjectPlugins: () => [{ pluginId: "plugin_one", displayName: "QA plugin" }],
  useProjectPlugin: (id?: string) => id === "plugin_one" ? {
    versions: [{ pluginVersionId: "version_7", declaredVersion: "1.2.0", status: "ready" }],
  } : undefined,
  usePluginVersion: () => undefined,
}));
vi.mock("@/hooks/usePluginsEnabled", () => ({
  usePluginsEnabledState: () => flag.plugins,
}));

const TITLES: Record<string, string> = {
  "claude.endpoint.https": "The server URL uses https",
  "claude.submission.listing-fields":
    "Listing fields follow the portal's rules",
  "claude.submission.access-matches-annotations":
    "The read or write declaration matches the tool annotations",
  "claude.submission.use-cases": "Each use case has an example prompt",
};

const plans = vi.hoisted(() => ({
  getTestPlan: vi.fn(),
  draftTestPlan: vi.fn(),
  saveTestPlan: vi.fn(),
  getToolTests: vi.fn(),
}));
vi.mock("@/lib/apis/directory-test-plan-api", () => plans);
// The reviewer section reads Convex and project secrets, and has its own
// tests; on this page it is left out of Test & launch.
vi.mock("../ReviewerSection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ReviewerSection")>()),
  ReviewerPath: () => null,
}));

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

/** A ChatGPT plugin rehearsal before its plugin is chosen. */
function pluginSubmission(): SubmissionView {
  return {
    ...submission(),
    id: "sub_2",
    directory: "openai",
    flowId: "chatgpt-plugin",
    flowVersion: CHATGPT_PLUGIN_FLOW.version,
    answers: [],
    steps: placeDirectoryResults({ flow: CHATGPT_PLUGIN_FLOW, answers: [] }),
    resultsRunId: null,
    submissionUrl: CHATGPT_PLUGIN_FLOW.submissionUrl,
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
    api.updateDirectorySubmission.mockResolvedValue(submission());
    const view = submission();
    api.getDirectorySubmissionHandoff.mockResolvedValue(
      buildDirectoryHandoff({
        flow: CLAUDE_CONNECTOR_FLOW,
        submission: view,
        results: view.steps,
        resultsRunId: view.resultsRunId,
        latestRun: null,
        events: [],
        snapshots: {},
      }),
    );
    api.listSubmissionEvents.mockResolvedValue([]);
    context.convexProjectId = "proj_1";
    context.selectedServerEntry = { name: "Sample server" };
    flag.plugins = true;
    flag.value = true;
  });

  it("opens the linked submission and selects its server without visiting the picker", async () => {
    context.selectedServerEntry = null;
    renderRoute("?submission=sub_1&project=proj_1");
    await waitFor(() => expect(api.getDirectorySubmission).toHaveBeenCalledWith(expect.objectContaining({ submissionId: "sub_1", projectId: "proj_1" })));
    await waitFor(() => expect(context.setSelectedServer).toHaveBeenCalledWith("Sample server"));
    expect(await screen.findByRole("heading", { level: 1, name: "Connection" })).toBeVisible();
  });

  it("keeps the ChatGPT tab when picking the same server or switching to another saved submission", async () => {
    const current = { ...pluginSubmission(), pluginId: "plugin_one" };
    const next = { ...current, id: "sub_other", serverId: "srv_2" };
    api.getDirectoryFlow.mockResolvedValue(CHATGPT_PLUGIN_FLOW);
    api.getDirectorySubmission.mockImplementation(async ({ submissionId }) => submissionId === next.id ? next : current);
    api.listServerSubmissions.mockImplementation(async (_, serverId) => serverId === next.serverId
      ? [next] : [current, { ...current, id: "newer", updatedAt: current.updatedAt + 100 }]);
    renderRoute("?submission=sub_2");
    const mcpTab = await screen.findByRole("tab", { name: /MCP/ });
    await userEvent.click(mcpTab);
    await chooseServer("Sample server");
    expect(mcpTab).toHaveAttribute("aria-selected", "true");
    expect(api.listServerSubmissions).not.toHaveBeenCalled();

    await chooseServer("Other server");
    await waitFor(() => expect(api.getDirectorySubmission).toHaveBeenCalledWith({ projectId: "proj_1", submissionId: next.id }));
    expect(await screen.findByRole("tab", { name: /MCP/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Server" })).toHaveTextContent("Other server");
    expect(screen.queryByText("ChatGPT releases")).toBeNull();
    await chooseServer("Sample server");
    await waitFor(() => expect(api.getDirectorySubmission).toHaveBeenLastCalledWith({ projectId: "proj_1", submissionId: current.id }));
    expect(await screen.findByRole("tab", { name: /MCP/ })).toHaveAttribute("aria-selected", "true");
    expect(api.createDirectorySubmission).not.toHaveBeenCalled();
    expect(api.startDirectorySubmissionRun).not.toHaveBeenCalled();
  });

  it("opens a new server's first Claude draft on the current step", async () => {
    const next = { ...submission(), id: "new_draft", serverId: "srv_2" };
    api.createDirectorySubmission.mockResolvedValue(next);
    api.getDirectorySubmission.mockImplementation(async ({ submissionId }) => submissionId === next.id ? next : submission());
    renderRoute("?submission=sub_1");
    await userEvent.click(await screen.findByRole("button", { name: /^Listing/ }));
    await chooseServer("Other server");
    await waitFor(() => expect(api.getDirectorySubmission).toHaveBeenCalledWith({ projectId: "proj_1", submissionId: next.id }));
    expect(await screen.findByRole("heading", { name: "Listing" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Server" })).toHaveTextContent("Other server");
    expect(api.createDirectorySubmission).toHaveBeenCalledWith({ projectId: "proj_1", serverId: "srv_2", flowId: "claude-connector" }, expect.any(String));
    expect(api.startDirectorySubmissionRun).not.toHaveBeenCalled();
  });

  it("sends a user without the flag back to Servers", () => {
    flag.value = false;
    renderRoute();
    expect(screen.getByTestId("navigate")).toHaveAttribute(
      "data-to",
      "/servers",
    );
  });

  it("renders nothing while the flag is still loading", () => {
    flag.value = undefined;
    const { container } = renderRoute();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("navigate")).toBeNull();
  });

  it("shows marketplace cards before the rehearsal and opens Claude", async () => {
    api.listServerSubmissions.mockResolvedValue([
      { ...submission(), id: "sub_0", updatedAt: Date.now() },
    ]);
    renderRoute();
    expect(screen.getByRole("heading", { name: "Readiness" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Claude" })).toBeVisible();
    expect(screen.getByRole("button", { name: "ChatGPT" })).toBeVisible();
    expect((await screen.findAllByText("Status unknown"))).toHaveLength(2);
    expect(screen.queryByText("Rehearsal")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.getByText("Claude releases")).toBeVisible();
    expect(await screen.findByText("Published release")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "All marketplaces" }));
    expect(screen.getByRole("heading", { name: "Readiness" })).toBeVisible();
  });

  it("starts one run from the overview using the saved submission", async () => {
    api.listServerSubmissions.mockResolvedValue([submission()]);
    api.startDirectorySubmissionRun.mockResolvedValue({ runId: "run_2" });
    renderRoute();
    await userEvent.click(screen.getByRole("button", { name: "Claude" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start checks" }));
    await waitFor(() => expect(api.startDirectorySubmissionRun).toHaveBeenCalledTimes(1));
    expect(api.startDirectorySubmissionRun.mock.calls[0][0]).toEqual({ projectId: "proj_1", submissionId: "sub_1" });
    expect(api.createDirectorySubmission).not.toHaveBeenCalled();
  });

  it("starts ChatGPT checks against the plugin version saved on the submission", async () => {
    const plugin = { ...pluginSubmission(), pluginId: "plugin_one", pluginVersionId: "version_7" };
    api.listServerSubmissions.mockResolvedValue([plugin]);
    api.getDirectoryFlow.mockResolvedValue(CHATGPT_PLUGIN_FLOW);
    api.getDirectorySubmission.mockResolvedValue(plugin);
    api.startDirectorySubmissionRun.mockResolvedValue({ runId: "run_2" });
    renderRoute();
    await userEvent.click(screen.getByRole("button", { name: "ChatGPT" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start checks" }));
    await waitFor(() => expect(api.startDirectorySubmissionRun).toHaveBeenCalledWith(
      { projectId: "proj_1", submissionId: "sub_2" }, expect.any(String), "version_7", undefined,
    ));
    expect(screen.getByRole("region", { name: "Readiness checks" })).toHaveTextContent(/ChatGPT plugin package\s*QA plugin · 1\.2\.0/);
    expect(api.startDirectorySubmissionRun).toHaveBeenCalledTimes(1);
  });

  it("keeps ChatGPT release history available when plugin checks are disabled", async () => {
    flag.plugins = false;
    api.listServerSubmissions.mockResolvedValue([pluginSubmission()]);
    renderRoute();
    await userEvent.click(screen.getByRole("button", { name: "ChatGPT" }));
    expect(await screen.findByRole("heading", { name: "Published release" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start checks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Go step by step" })).toBeNull();
  });

  describe("confirming a test plan revision before a run uses it", () => {
    const KEY = "mcpjam-readiness-test-plan-confirmed:proj_1:sub_1";
    const plan = (
      revision: number,
      content: DirectoryTestPlan = draftDirectoryTestPlan([
        { name: "search_docs", annotations: { readOnlyHint: true } },
        { name: "create_note", annotations: { destructiveHint: false } },
        { name: "delete_note" },
      ]),
    ) => ({
      submissionId: "sub_1",
      revision,
      counts: { tools: 3, cases: 3, fixtures: 0, cleanup: 0 },
      savedBy: "user_2",
      savedAt: Date.now() - 3_600_000,
      plan: content,
      issues: [],
      catalog: null,
    });
    const note = { $fixture: "note", value: "id" };
    /** Every part the dialog must show: nested arguments, fixtures, cleanup. */
    const CALLS: DirectoryTestPlan = {
      schemaVersion: 1,
      fixtures: [
        {
          id: "note",
          description: "A note the plan creates",
          origin: "created",
          capture: { id: "note.id" },
        },
        {
          id: "project",
          description: "The reviewer's sample project",
          origin: "existing",
          values: { id: "proj_sample" },
        },
      ],
      tools: [
        {
          tool: "search_docs",
          effect: "read",
          openWorld: true,
          action: "run",
          writes: [],
        },
        {
          tool: "list_projects",
          effect: "read",
          openWorld: false,
          action: "excluded",
          exclusion: { reason: "costly" },
          writes: [],
        },
        {
          tool: "create_note",
          effect: "write",
          openWorld: false,
          action: "run",
          writes: ["note", "project"],
        },
        {
          tool: "delete_note",
          effect: "destructive",
          openWorld: false,
          action: "run",
          writes: ["note"],
        },
      ],
      cases: [
        {
          id: "create_note#valid",
          tool: "create_note",
          kind: "valid",
          arguments: {
            title: "Sample note",
            project: { $fixture: "project", value: "id" },
            tags: ["a", "b"],
          },
          creates: ["note"],
        },
        {
          id: "search_docs#valid",
          tool: "search_docs",
          kind: "valid",
          arguments: {
            query: "pricing",
            filter: { owner: { email: "review@example.com" } },
          },
        },
        {
          id: "search_docs#missing-arguments",
          tool: "search_docs",
          kind: "negative",
          arguments: {},
          expectedError: "invalid-arguments",
        },
        {
          id: "delete_note#valid",
          tool: "delete_note",
          kind: "valid",
          arguments: { id: note },
        },
      ],
      budget: { maxCalls: 4, concurrency: 1, callTimeoutMs: 30_000 },
      cleanup: [
        {
          fixture: "note",
          tool: "delete_note",
          arguments: { id: note, hard: true },
        },
      ],
    };
    const shownJson = (dialog: HTMLElement) =>
      [...dialog.querySelectorAll("pre")].map((block) => block.textContent);
    const json = (value: unknown) => JSON.stringify(value, null, 2);
    const sentRevisions = () =>
      api.startDirectorySubmissionRun.mock.calls.map((call) => call[3]);

    /** Opens the rehearsal and presses the run button once it reads `label`. */
    async function pressRun(label: string) {
      const page = renderRoute();
      const marketplace = screen.queryByRole("button", { name: "Claude" });
      if (marketplace) await userEvent.click(marketplace);
      const start = screen.queryByRole("button", { name: "Go step by step" });
      if (start) await userEvent.click(start);
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

    it("shows every call in run order with its exact arguments, nested ones included", async () => {
      plans.getTestPlan.mockResolvedValue(plan(3, CALLS));
      await pressRun("Run checks with test plan revision 3");
      const dialog = screen.getByRole("alertdialog");
      const calls = within(dialog).getAllByRole("listitem");
      expect(calls.map((call) => call.querySelector("p")?.textContent)).toEqual(
        [
          "create_note, valid input",
          "search_docs, valid input, reaches outside the server",
          "search_docs, negative case, reaches outside the server",
          "delete_note, valid input",
        ],
      );
      expect(shownJson(dialog).slice(0, 4)).toEqual(
        CALLS.cases.map((testCase) => json(testCase.arguments)),
      );
      expect(calls[2]).toHaveTextContent(
        "Expects an invalid-arguments refusal.",
      );
      expect(calls[0]).toHaveTextContent("Expects a result.");
    });

    it("shows the fixtures and the cleanup calls with their arguments, and names excluded tools", async () => {
      plans.getTestPlan.mockResolvedValue(plan(3, CALLS));
      await pressRun("Run checks with test plan revision 3");
      const dialog = screen.getByRole("alertdialog");
      expect(dialog).toHaveTextContent("note: A note the plan creates");
      expect(within(dialog).getAllByRole("listitem")[0]).toHaveTextContent(
        "Creates note.",
      );
      expect(dialog).toHaveTextContent("Created by call 1.");
      expect(dialog).toHaveTextContent(
        "Its values come from these paths in that call's result:",
      );
      expect(dialog).toHaveTextContent(
        "Tools allowed to change it: create_note and delete_note.",
      );
      expect(dialog).toHaveTextContent("Already in the reviewer's account.");
      expect(dialog).toHaveTextContent("delete_note removes note");
      expect(shownJson(dialog).slice(4)).toEqual([
        json({ id: "note.id" }),
        json({ id: "proj_sample" }),
        json(CALLS.cleanup[0].arguments),
      ]);
      expect(dialog).toHaveTextContent(
        "list_projects is excluded and not called.",
      );
    });

    it("shows a created fixture's values as the paths the run reads, not values the run ignores", async () => {
      const decoy: DirectoryTestPlan = {
        ...CALLS,
        fixtures: CALLS.fixtures.map((fixture) =>
          fixture.origin === "created"
            ? { ...fixture, values: { id: "note_decoy" } }
            : fixture,
        ),
      };
      plans.getTestPlan.mockResolvedValue(plan(3, decoy));
      await pressRun("Run checks with test plan revision 3");
      const dialog = screen.getByRole("alertdialog");
      expect(shownJson(dialog)).toContain(json({ id: "note.id" }));
      expect(dialog).not.toHaveTextContent("note_decoy");
    });

    it("shows nothing and sends nothing when the saved plan moves past the revision the run would send", async () => {
      await pressRun("Run checks with test plan revision 3");
      expect(screen.getByRole("alertdialog")).toBeVisible();
      // Another session saves revision 4 while the dialog is open.
      plans.getTestPlan.mockResolvedValue(plan(4));
      api.getDirectorySubmission.mockResolvedValue({
        ...submission(),
        lastRunId: "run_9",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await screen.findByRole("button", {
        name: "Run checks again with test plan revision 4",
      });
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(api.startDirectorySubmissionRun).not.toHaveBeenCalled();
    });

    it("sends no revision and asks nothing when no plan is saved", async () => {
      plans.getTestPlan.mockResolvedValue(null);
      renderRoute();
      await userEvent.click(screen.getByRole("button", { name: "Claude" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Go step by step" }),
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
    renderRoute();
    await userEvent.click(screen.getByRole("button", { name: "Claude" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Go step by step" }),
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

  it("asks for a saved server after choosing a marketplace", async () => {
    context.selectedServerEntry = null;
    renderRoute();
    expect(screen.queryByRole("button", { name: "Server" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(await screen.findByText("Choose a saved server to start a submission.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Server" })).toBeVisible();
  });

  it("starts a connector rehearsal and renders the Listing step from the flow", async () => {
    renderRoute();
    await userEvent.click(screen.getByRole("button", { name: "Claude" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Go step by step" }),
    );
    expect(api.createDirectorySubmission).toHaveBeenCalledWith(
      { projectId: "proj_1", serverId: "srv_1", flowId: "claude-connector" },
      expect.stringMatching(/^ui-srv_1-/),
    );

    // Step 1: the result for the server URL sits under that field.
    expect(
      await screen.findByRole("heading", { level: 1, name: "Connection" }),
    ).toBeVisible();
    expect(screen.getByText("https://mcp.example.com/mcp")).toBeVisible();
    expect(screen.getByText("The server URL uses https")).toBeVisible();
    const header = within(screen.getByRole("region", { name: "Readiness checks" }));
    expect(header.getByRole("status")).toHaveTextContent("1 blocker");
    expect(header.getByRole("button", { name: "Server" })).toBeVisible();
    expect(header.queryByRole("button", { name: "Details" })).toBeNull();
    expect(header.getByText("Claude preview")).toHaveAttribute("title", expect.stringContaining("Rules as of Nov 13, 2026"));

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
    expect(header.getByRole("status")).toHaveTextContent("1 blocker");
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
    renderRoute();
    await userEvent.click(screen.getByRole("button", { name: "Claude" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Go step by step" }),
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
    renderRoute();
    await userEvent.click(screen.getByRole("button", { name: "Claude" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Go step by step" }),
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
    // The handoff summary an agent reads, above the portal's review table.
    const handoff = await screen.findByRole("region", {
      name: "Handoff summary",
    });
    expect(
      await within(handoff).findByText("1 blocker in 2 evaluated checks."),
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
      await screen.findByRole("button", { name: "Mark as submitted" }),
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

  it("starts a ChatGPT plugin rehearsal from the directory choice", async () => {
    api.getDirectoryFlow.mockResolvedValue(CHATGPT_PLUGIN_FLOW);
    api.createDirectorySubmission.mockResolvedValue(pluginSubmission());
    api.getDirectorySubmission.mockResolvedValue(pluginSubmission());
    api.listServerSubmissions.mockResolvedValue([
      { ...submission(), id: "sub_0", updatedAt: Date.now() },
    ]);
    renderRoute();
    await screen.findAllByText("Status unknown");
    await userEvent.click(screen.getByRole("button", { name: "ChatGPT" }));
    expect(screen.queryByRole("group", { name: "Directory" })).toBeNull();
    // The saved Claude rehearsal belongs to the other directory.
    expect(screen.queryByText("Saved rehearsals for this server")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Go step by step" }),
    );
    expect(api.createDirectorySubmission).toHaveBeenCalledWith(
      { projectId: "proj_1", serverId: "srv_1", flowId: "chatgpt-plugin" },
      expect.stringMatching(/^ui-srv_1-/),
    );
    expect(
      await screen.findByText(/Choose a plugin ZIP, a source folder, or a saved plugin below\./),
    ).toBeVisible();
  });

  it("opens a saved ChatGPT plugin rehearsal on the plugin page, which waits for a version", async () => {
    api.getDirectoryFlow.mockResolvedValue(CHATGPT_PLUGIN_FLOW);
    api.getDirectorySubmission.mockResolvedValue(pluginSubmission());
    // Untitled, so the list names it by its flow.
    api.listServerSubmissions.mockResolvedValue([pluginSubmission()]);
    renderRoute();
    await userEvent.click(screen.getByRole("button", { name: "ChatGPT" }));
    await userEvent.click(await screen.findByRole("button", { name: "Go step by step" }));

    expect(
      await screen.findByText(/Choose a plugin ZIP, a source folder, or a saved plugin below\./),
    ).toBeVisible();
    expect(
      screen.getByText(
        "ChatGPT plugin package",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("Choose a plugin package to run checks."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Run checks" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Upload ZIP or folder" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish test import" }));
    expect(api.updateDirectorySubmission).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: "sub_2" }),
      expect.objectContaining({ plugin: { pluginId: "plugin_one", pluginVersionId: "imported_version" } }),
    );
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
    await userEvent.click(screen.getByRole("button", { name: "Claude" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Go step by step" }),
    );
    await screen.findByRole("heading", { level: 1, name: "Connection" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(screen.getByLabelText(/^Name/), " 2");
  }

  it("starts over on another server while a rehearsal is being created", async () => {
    let finish: (view: SubmissionView) => void = () => undefined;
    api.createDirectorySubmission.mockReturnValue(
      new Promise<SubmissionView>((resolve) => (finish = resolve)),
    );
    const { rerender } = render(page("Sample server"));
    await userEvent.click(screen.getByRole("button", { name: "Claude" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Go step by step" }),
    );
    expect(
      screen.getByRole("button", { name: "Go step by step" }),
    ).toBeDisabled();

    rerender(page("Other server"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Go step by step" })).toBeEnabled());
    expect(api.listServerSubmissions).toHaveBeenLastCalledWith(
      "proj_1",
      "srv_2",
      expect.any(AbortSignal),
    );

    // The first server's rehearsal is not opened when it arrives late.
    await act(async () => finish({ ...submission(), id: "sub_9" }));
    rerender(page("Sample server"));
    expect(screen.getByText("Claude releases")).toBeVisible();
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
      await screen.findByText("Claude releases"),
    ).toBeVisible();
  });
});
