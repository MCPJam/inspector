import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalSuiteRun } from "../../evals/types";
import { RunServerGroups } from "../run-server-groups";

const mocks = vi.hoisted(() => ({
  showGroups: true,
  runsLoading: false,
  runsById: new Map<string, unknown>(),
  failedRunIds: new Set<string>(),
  groups: [] as Array<{ _id: string; name: string }>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => mocks.showGroups,
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: mocks.groups,
    isLoading: false,
  }),
}));
vi.mock("../../evals/use-runs-iterations", () => ({
  useRunsIterations: () => ({
    runsById: mocks.runsById,
    isLoading: mocks.runsLoading,
    failedRunIds: mocks.failedRunIds,
  }),
}));

function makeRun(
  id: string,
  host: string,
  servers: string[],
  groupId?: string,
): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite-1",
    projectId: "project-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: {
      tests: [],
      environment: { servers },
      ...(groupId ? { environmentServerAttachmentId: groupId } : {}),
    },
    status: "completed",
    result: "passed",
    createdAt: 1_700_000_000_000,
    source: "ui",
    namedHostId: host,
  } as EvalSuiteRun;
}

const hostNamesById = new Map<string, string | null>([
  ["h-claude", "Claude Code"],
  ["h-codex", "Codex"],
]);

function renderWith(runs: EvalSuiteRun[]) {
  mocks.runsById = new Map(runs.map((run) => [run._id, run]));
  return render(
    <RunServerGroups targets={runs} hostNamesById={hostNamesById} />,
  );
}

describe("RunServerGroups", () => {
  beforeEach(() => {
    mocks.showGroups = true;
    mocks.runsLoading = false;
    mocks.failedRunIds = new Set();
    mocks.groups = [
      { _id: "g-uat", name: "CTRL UAT" },
      { _id: "g-sim", name: "CTRL SimNext" },
    ];
  });

  it("shows a shared group once, with its servers as chips", () => {
    renderWith([
      makeRun("r1", "h-claude", ["CTRL UAT"], "g-uat"),
      makeRun("r2", "h-codex", ["CTRL UAT"], "g-uat"),
    ]);
    // The group and a server of the same name both show.
    expect(screen.getAllByText("CTRL UAT")).toHaveLength(2);
    expect(screen.getByLabelText("Server group")).toBeInTheDocument();
    expect(screen.queryByText(/^on /)).toBeNull();
  });

  it("names the clients of each group when targets used different ones", () => {
    renderWith([
      makeRun("r1", "h-claude", ["CTRL UAT"], "g-uat"),
      makeRun("r2", "h-codex", ["CTRL SimNext"], "g-sim"),
    ]);
    const entries = screen.getAllByTestId("evaluate-run-server-group");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("on Claude Code");
    expect(entries[1]).toHaveTextContent("on Codex");
  });

  it("shows servers without a group name when the run recorded none", () => {
    renderWith([makeRun("r1", "h-claude", ["DMS DEV"])]);
    expect(screen.getByText("DMS DEV")).toBeInTheDocument();
    expect(screen.getByLabelText("Servers")).toBeInTheDocument();
  });

  it("reads a group missing from the list as deleted", () => {
    renderWith([makeRun("r1", "h-claude", ["DMS DEV"], "g-gone")]);
    expect(screen.getByText("Deleted group")).toBeInTheDocument();
  });

  it("hides group names when project environments are off", () => {
    mocks.showGroups = false;
    renderWith([
      makeRun("r1", "h-claude", ["CTRL UAT"], "g-uat"),
      makeRun("r2", "h-codex", ["CTRL SimNext"], "g-sim"),
    ]);
    expect(screen.queryByText("CTRL SimNext", { selector: ".font-medium" }))
      .toBeNull();
    expect(screen.getByLabelText("Servers")).toBeInTheDocument();
    // Still says which client used which servers.
    expect(screen.getAllByTestId("evaluate-run-server-group")).toHaveLength(2);
  });

  it("draws nothing until every target has answered", () => {
    mocks.runsLoading = true;
    renderWith([makeRun("r1", "h-claude", ["CTRL UAT"], "g-uat")]);
    expect(screen.queryByTestId("evaluate-run-server-groups")).toBeNull();
  });

  it("draws nothing when a target's read failed, rather than part of the launch", () => {
    const answered = makeRun("r1", "h-claude", ["CTRL UAT"], "g-uat");
    mocks.failedRunIds = new Set(["r2"]);
    mocks.runsById = new Map([[answered._id, answered]]);
    render(
      <RunServerGroups
        targets={[answered, makeRun("r2", "h-codex", ["CTRL SimNext"], "g-sim")]}
        hostNamesById={hostNamesById}
      />,
    );
    expect(screen.queryByTestId("evaluate-run-server-groups")).toBeNull();
  });

  it("folds servers past the room into a focusable +N with their names", async () => {
    const servers = Array.from({ length: 7 }, (_, i) => `server-number-${i}`);
    renderWith([makeRun("r1", "h-claude", servers, "g-uat")]);
    const more = screen.getByText(/^\+\d+$/);
    const hidden = Number(more.textContent?.slice(1));
    expect(hidden).toBeGreaterThan(0);
    expect(more).toHaveAttribute(
      "aria-label",
      `${hidden} more: ${servers.slice(-hidden).join(", ")}`,
    );
    await userEvent.tab();
    await userEvent.tab();
    expect(more).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      servers.slice(-hidden).join(", "),
    );
  });
});
