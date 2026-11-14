/**
 * The Readiness page end to end with the API mocked: a result under a field
 * opens its evidence, the review page's gate saves through the submission
 * and the result it moved still shows on its step (V8), and "Mark as
 * submitted" records the receipt the review page then shows.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDirectoryHandoff } from "@mcpjam/sdk/browser";
import type {
  SubmissionEvent,
  SubmissionEventBody,
} from "@/lib/apis/directory-submissions-api";
import { ReadinessRoute } from "../ReadinessPage";
import {
  flow,
  HTTPS,
  LISTING_FIELDS,
  recordedEvent,
  SCOPE,
  submissionView,
} from "./readiness-fixtures";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => true,
}));
vi.mock("@/lib/app-route-context", () => ({
  useAppRouteContext: () => ({
    convexProjectId: "proj_1",
    isAuthenticated: true,
    displayServerConfigs: {
      "Sample server": {
        name: "Sample server",
        config: { url: "https://mcp.example.com/mcp" },
        connectionStatus: "disconnected",
      },
    },
    selectedServerEntry: { name: "Sample server" },
    setSelectedServer: vi.fn(),
  }),
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({
    serversByName: new Map([["Sample server", "srv_1"]]),
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-task-owner-id", () => ({
  useTaskOwnerId: () => "user_1",
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({
    members: [
      {
        userId: "user_1",
        email: "review@example.com",
        user: {
          name: "Sample Person",
          email: "review@example.com",
          imageUrl: "",
        },
      },
    ],
  }),
}));

const api = vi.hoisted(() => ({
  getDirectoryFlow: vi.fn(),
  getDirectorySubmissionHandoff: vi.fn(),
  exportDirectorySubmission: vi.fn(),
  listServerSubmissions: vi.fn(),
  createDirectorySubmission: vi.fn(),
  getDirectorySubmission: vi.fn(),
  updateDirectorySubmission: vi.fn(),
  startDirectorySubmissionRun: vi.fn(),
  getSubmissionFinding: vi.fn(),
  listSubmissionEvents: vi.fn(),
  recordSubmissionEvent: vi.fn(),
}));
vi.mock("@/lib/apis/directory-submissions-api", () => api);

async function openRehearsal() {
  render(<ReadinessRoute />);
  await userEvent.click(screen.getByRole("button", { name: /MCP connector/ }));
  await screen.findByRole("heading", { level: 1, name: "Connection" });
  return within(
    screen.getByRole("navigation", { name: "Claude submission steps" }),
  );
}

describe("the Readiness page's evidence, gate and status", () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    api.getDirectoryFlow.mockResolvedValue(flow);
    api.listServerSubmissions.mockResolvedValue([]);
    api.createDirectorySubmission.mockResolvedValue(submissionView());
    api.getDirectorySubmission.mockResolvedValue(submissionView());
    api.listSubmissionEvents.mockResolvedValue([]);
    const view = submissionView();
    api.getDirectorySubmissionHandoff.mockResolvedValue(
      buildDirectoryHandoff({
        flow,
        submission: view,
        results: view.steps,
        resultsRunId: view.resultsRunId,
        latestRun: null,
        events: [],
        snapshots: {},
      }),
    );
  });

  it("opens a result's evidence from under the field it read", async () => {
    api.getSubmissionFinding.mockRejectedValue(new Error("Request timed out."));
    await openRehearsal();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Show evidence for The server URL uses https",
      }),
    );
    const drawer = within(await screen.findByRole("dialog"));
    expect(
      drawer.getByRole("heading", { name: "The server URL uses https" }),
    ).toBeVisible();
    expect(api.getSubmissionFinding).toHaveBeenCalledWith(
      SCOPE,
      HTTPS,
      expect.any(AbortSignal),
    );
  });

  it("V8: a Listing check moved to warn only is saved, named, and still shows on its step", async () => {
    api.updateDirectorySubmission.mockResolvedValue(
      submissionView(undefined, {
        revision: 4,
        checkGate: { warnOnly: [LISTING_FIELDS] },
      }),
    );
    const rail = await openRehearsal();
    await userEvent.click(rail.getByRole("button", { name: /Review/ }));
    expect(
      screen.getByText("Not ready. 1 check in the gate failed."),
    ).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Choose the checks" }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: /^Listing fields follow/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save the gate" }),
    );
    expect(api.updateDirectorySubmission).toHaveBeenCalledWith(SCOPE, {
      expectedRevision: 3,
      checkGate: { failOn: [], warnOnly: [LISTING_FIELDS] },
    });
    expect(
      await screen.findByText(
        "Warns only on: Listing fields follow the portal's rules.",
      ),
    ).toBeVisible();
    expect(screen.getByText(/^Ready under this gate\./)).toBeVisible();

    await userEvent.click(rail.getByRole("button", { name: /Listing/ }));
    expect(
      screen.getByText("Add a one-liner of 200 characters or fewer."),
    ).toBeVisible();
  });

  it("marks the submission as submitted from the review page's buttons", async () => {
    let recorded: SubmissionEvent[] = [];
    api.listSubmissionEvents.mockImplementation(
      async (_scope: unknown, kind: string) =>
        recorded.filter((event) => event.kind === kind),
    );
    api.recordSubmissionEvent.mockImplementation(
      async (_scope: unknown, body: SubmissionEventBody) => {
        const event = recordedEvent({
          id: "evt_1",
          kind: "status",
          state: body.state,
          reference: body.reference,
        });
        recorded = [event];
        return event;
      },
    );
    // The handoff summary is built from the recorded events on each read.
    api.getDirectorySubmissionHandoff.mockImplementation(async () => {
      const view = submissionView();
      return buildDirectoryHandoff({
        flow,
        submission: view,
        results: view.steps,
        resultsRunId: view.resultsRunId,
        latestRun: null,
        events: recorded,
        snapshots: {},
      });
    });
    const rail = await openRehearsal();
    await userEvent.click(rail.getByRole("button", { name: /Review/ }));
    expect(
      screen.getByRole("button", { name: "Copy for the portal" }),
    ).toBeVisible();

    await userEvent.click(
      await screen.findByRole("button", { name: "Mark as submitted" }),
    );
    const form = within(await screen.findByRole("dialog"));
    await userEvent.type(
      form.getByLabelText("Confirmation reference"),
      "SUB-2048",
    );
    await userEvent.click(
      form.getByRole("button", { name: "Mark as submitted" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Server submitted for review",
      }),
    ).toBeVisible();
    const card = screen.getByRole("region", { name: "Submission status" });
    expect(within(card).getByText("Reference SUB-2048")).toBeVisible();
    expect(screen.getByText("Recorded by you on Oct 29, 2026")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Mark as submitted" }),
    ).toBeNull();
    // An event changes no revision, yet the handoff summary reads again.
    expect(
      await screen.findByText(/^Submitted, observed by you on Oct 29, 2026/),
    ).toBeVisible();
  });
});
