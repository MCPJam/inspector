/**
 * The handoff summary reads the route an agent reads and shows the same
 * record: status, counts, blockers, unconfirmed declarations, missing
 * answers, next actions with the operation to call, and what is left in the
 * portal. The export saves the API's own bytes.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  buildDirectoryExport,
  buildDirectoryHandoff,
  placeDirectoryResults,
  renderDirectoryExportMarkdown,
  type DirectoryAnswer,
  type DirectoryHandoffInput,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import { HandoffPanel } from "../HandoffPanel";

const api = vi.hoisted(() => ({
  getDirectorySubmissionHandoff: vi.fn(),
  exportDirectorySubmission: vi.fn(),
}));
vi.mock("@/lib/apis/directory-submissions-api", () => api);
const download = vi.hoisted(() => ({ downloadTextFile: vi.fn() }));
vi.mock("@/lib/download-text-file", () => download);
const toast = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/toast", () => toast);

const flow = CLAUDE_CONNECTOR_FLOW;
const SCOPE = { projectId: "proj_1", submissionId: "sub_1" };
const NOV_12 = Date.UTC(2026, 10, 12, 12);
const people = {
  you: "user_you",
  nameOf: (id: string) => (id === "user_pm" ? "Sample Person" : undefined),
};

const blocker: PlacedFinding["finding"] = {
  id: "claude.submission.access-matches-annotations",
  title: "The read or write declaration matches the tool annotations",
  lane: "submission-artifacts",
  class: "required",
  status: "violated",
  remediation: "Choose Read and write: 64 tools write.",
  source: {},
  provenance: "wire",
  intrusiveness: "passive",
  evaluatedAt: "2026-11-12T12:00:00.000Z",
  engineVersion: "test",
};

function input(
  events: DirectoryHandoffInput["events"] = [],
): DirectoryHandoffInput {
  const answers: DirectoryAnswer[] = [
    { key: "listing.name", value: "Sample server", origin: "set", revision: 3 },
    { key: "listing.slug", value: "Not A Slug", origin: "set", revision: 3 },
  ];
  return {
    flow,
    submission: {
      id: "sub_1",
      projectId: "proj_1",
      flowVersion: flow.version,
      revision: 4,
      updatedAt: NOV_12,
      answers,
    },
    results: placeDirectoryResults({ flow, answers, findings: [blocker] }),
    resultsRunId: "run_1",
    latestRun: { id: "run_1", status: "completed", resumable: false },
    events,
    snapshots: {},
  };
}

function draw(version = "4") {
  return render(
    <HandoffPanel
      flow={flow}
      scope={SCOPE}
      version={version}
      people={people}
    />,
  );
}

const listUnder = (title: string) => {
  const heading = screen.getByRole("heading", { name: title });
  const list = heading.parentElement;
  if (!list) throw new Error(`No list under ${title}`);
  return within(list);
};

describe("HandoffPanel", () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    download.downloadTextFile.mockReset();
    toast.toast.error.mockReset();
    api.getDirectorySubmissionHandoff.mockResolvedValue(
      buildDirectoryHandoff(input()),
    );
  });

  it("shows what a teammate or an agent needs to continue", async () => {
    draw();
    expect(
      await screen.findByText("1 blocker in 1 evaluated check."),
    ).toBeVisible();
    expect(api.getDirectorySubmissionHandoff).toHaveBeenCalledWith(
      SCOPE,
      expect.any(AbortSignal),
    );
    expect(screen.getByText("Not recorded")).toBeVisible();
    expect(screen.getByText("1 established")).toBeVisible();

    expect(
      listUnder("Blockers").getByText(
        "The read or write declaration matches the tool annotations",
      ),
    ).toBeVisible();
    // Read only is the portal's default, and nobody has confirmed it.
    expect(
      listUnder("Unconfirmed declarations").getByText(
        "Read/write capabilities",
      ),
    ).toBeVisible();
    const missing = listUnder("Missing answers");
    expect(missing.getByText("One-liner")).toBeVisible();
    // An answer the portal would refuse, with the portal's reason.
    expect(missing.getByText("Slug")).toBeVisible();
    expect(
      missing.getByText("Use only lowercase letters, numbers, and hyphens."),
    ).toBeVisible();
  });

  it("names the operation an agent would call for each next action", async () => {
    draw();
    const actions = await screen.findByRole("heading", {
      name: "Next actions in MCPJam",
    });
    const list = within(actions.parentElement ?? document.body);
    const update = list.getAllByText("update_directory_submission");
    expect(update.length).toBeGreaterThan(0);
    expect(list.getByText("start_directory_submission_run")).toBeVisible();
    expect(
      list.getByText(/Run again after fixing the 1 blocker to recheck them\./),
    ).toBeVisible();
    // Fields by the review page's label, as the lists above name them.
    expect(
      list.getAllByText(/^Fields: .*Slug.*Support URL/).length,
    ).toBeGreaterThan(0);

    const portal = listUnder("Left to do in the Claude portal");
    expect(portal.getByText("Policy acknowledgements")).toBeVisible();
    expect(portal.getByText("Compliance")).toBeVisible();
    // An action named after its step names the step once.
    expect(portal.getAllByText("Connection")).toHaveLength(1);
    expect(
      listUnder("Still unknown").getByText(/No status is recorded/),
    ).toBeVisible();
  });

  it("shows the latest recorded status and who recorded it", async () => {
    api.getDirectorySubmissionHandoff.mockResolvedValue(
      buildDirectoryHandoff(
        input([
          {
            id: "evt_1",
            submissionId: "sub_1",
            projectId: "proj_1",
            kind: "status",
            reportedOrObserved: "reported",
            state: "in-review",
            actor: "user_pm",
            actorLabel: "Codex",
            createdAt: NOV_12,
          },
        ]),
      ),
    );
    draw();
    expect(
      await screen.findByText(
        "In review, reported by Codex (signed in as Sample Person) on Nov 12, 2026",
      ),
    ).toBeVisible();
  });

  it("exports the API's own bytes as JSON and as Markdown", async () => {
    const pack = buildDirectoryExport(input());
    const json = `${JSON.stringify(pack, null, 2)}\n`;
    const markdown = renderDirectoryExportMarkdown(pack);
    api.exportDirectorySubmission.mockImplementation(
      async (_scope: unknown, format: "json" | "markdown") => ({
        format,
        filename: `claude-connector-sub_1-r4.${format === "json" ? "json" : "md"}`,
        mediaType: format === "json" ? "application/json" : "text/markdown",
        content: format === "json" ? json : markdown,
      }),
    );
    draw();
    await userEvent.click(
      await screen.findByRole("button", { name: "Export JSON" }),
    );
    expect(api.exportDirectorySubmission).toHaveBeenCalledWith(SCOPE, "json");
    expect(download.downloadTextFile).toHaveBeenLastCalledWith(
      "claude-connector-sub_1-r4.json",
      json,
      "application/json;charset=utf-8",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Export Markdown" }),
    );
    expect(download.downloadTextFile).toHaveBeenLastCalledWith(
      "claude-connector-sub_1-r4.md",
      markdown,
      "text/markdown;charset=utf-8",
    );
  });

  it("says when the export did not download, and how to retry", async () => {
    api.exportDirectorySubmission.mockRejectedValue(
      new Error("The export timed out."),
    );
    draw();
    await userEvent.click(
      await screen.findByRole("button", { name: "Export JSON" }),
    );
    expect(toast.toast.error).toHaveBeenCalledWith(
      "The export did not download. The export timed out. Try exporting it again.",
    );
    expect(download.downloadTextFile).not.toHaveBeenCalled();
  });

  it("offers to load it again when the read fails", async () => {
    api.getDirectorySubmissionHandoff
      .mockRejectedValueOnce(new Error("The service did not answer."))
      .mockResolvedValueOnce(buildDirectoryHandoff(input()));
    draw();
    expect(
      await screen.findByText(
        /The handoff summary did not load\. The service did not answer\./,
      ),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Blockers" }),
    ).toBeVisible();
  });

  it("reads it again when the record changes", async () => {
    const { rerender } = draw("4");
    await screen.findByRole("heading", { name: "Blockers" });
    rerender(
      <HandoffPanel flow={flow} scope={SCOPE} version="5" people={people} />,
    );
    expect(api.getDirectorySubmissionHandoff).toHaveBeenCalledTimes(2);
  });
});
