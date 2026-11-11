import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { SuiteRunReview } from "../suite-run-review";
import { RunsAsLine, SuiteRunsAsLine } from "../suite-runs-as";
import { useSuiteAccountPreflight } from "../suite-run-account-preflight";
import { hasBlockingPreflight, type RunPreflightState } from "../suite-run-preflight";
import type { EvalCase, EvalSuite } from "../../evals/types";
import type { SuiteAccountsView } from "@/lib/evals/eval-accounts";
import type { RemoteServer } from "@/hooks/useProjects";

const state = vi.hoisted(() => ({
  flag: true,
  view: undefined as unknown,
  navigateApp: vi.fn(),
  queried: [] as string[],
}));

vi.mock("sonner", () => ({ toast: { loading: vi.fn(), error: vi.fn() } }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "eval-account-selection-enabled" ? state.flag : false,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(queries).map(([key, { query }]) => {
        state.queried.push(getFunctionName(query));
        return [key, state.view];
      }),
    ),
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("@/hooks/useProjects", () => ({
  shouldQueryProjectId: () => true,
  useProjectServers: () => ({ servers: projectServers }),
}));
vi.mock("@/lib/app-navigation", async (original) => ({
  ...(await original<typeof import("@/lib/app-navigation")>()),
  navigateApp: (to: string) => state.navigateApp(to),
}));

const projectServers: RemoteServer[] = ["Asana", "Linear"].map((name) => ({
  _id: `srv-${name.toLowerCase()}`,
  projectId: "project",
  name,
  enabled: true,
  transportType: "http",
}));

const suite = {
  _id: "suite",
  name: "Asana task triage",
  projectId: "project",
  environment: { servers: ["Asana", "Linear"] },
} as EvalSuite;
const cases = [{ _id: "one", runs: 1, models: [] }] as unknown as EvalCase[];

const live = { connectionId: "conn-live", name: "Live", isDefault: true, needsReauth: false };
const dummy = { connectionId: "conn-dummy", name: "Dummy", isDefault: false, needsReauth: false };

const emptyPreflight: RunPreflightState = {
  disconnected: [],
  removed: [],
  refused: [],
  disabledProviders: [],
  serverName: (ref) => ref,
};

function renderSheet(preflight: RunPreflightState) {
  // No project: the sheet renders its content with this preflight as given.
  return render(
    <SuiteRunReview
      suite={{ ...suite, projectId: undefined }}
      cases={cases}
      hostNamesById={new Map()}
      preflight={preflight}
      onStart={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

beforeEach(() => {
  state.flag = true;
  state.view = undefined;
  state.navigateApp.mockReset();
  state.queried = [];
});

describe("the Runs as you line", () => {
  it("names each server with the accounts its runs use", () => {
    render(
      <RunsAsLine
        entries={[
          {
            serverId: "srv-asana",
            serverName: "Asana",
            accounts: [
              { name: "Dummy", needsReauth: false },
              { name: "Live", needsReauth: false },
            ],
          },
          {
            serverId: "srv-linear",
            serverName: "Linear",
            accounts: [{ name: "Work", needsReauth: false }],
          },
        ]}
      />,
    );
    expect(screen.getByTestId("suite-runs-as")).toHaveTextContent(
      "Runs as you · Asana Dummy, Live · Linear Work",
    );
  });

  it("flags an account that needs reconnecting, and says nothing with no entries", () => {
    const { container, rerender } = render(
      <RunsAsLine
        entries={[
          {
            serverId: "srv-asana",
            serverName: "Asana",
            accounts: [{ name: "Dummy", needsReauth: true }],
          },
        ]}
      />,
    );
    expect(screen.getByTestId("suite-runs-as")).toHaveTextContent(
      "Runs as you · Asana Dummy Needs reconnect",
    );
    rerender(<RunsAsLine entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reads the suite's saved choice beside Setup Run", () => {
    state.view = {
      servers: [
        { serverId: "srv-asana", mode: "accounts", accounts: [live, dummy], chosen: ["conn-dummy"] },
      ],
      scheduleOwners: [],
    } satisfies SuiteAccountsView;
    render(<SuiteRunsAsLine suite={suite} projectId="project" />);
    expect(screen.getByTestId("suite-runs-as")).toHaveTextContent(
      "Runs as you · Asana Dummy",
    );
  });

  it("asks for nothing while the rollout flag is off", () => {
    state.flag = false;
    const { container } = render(
      <SuiteRunsAsLine suite={suite} projectId="project" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(state.queried).toEqual([]);
  });
});

describe("the Setup Run account checks", () => {
  it("names an account that needs reconnecting and keeps Start run off", async () => {
    renderSheet({
      ...emptyPreflight,
      accountProblems: [
        {
          kind: "needs_reconnect",
          serverId: "srv-asana",
          serverName: "Asana",
          connectionId: "conn-dummy",
          accountName: "Dummy",
        },
      ],
    });
    const notices = screen.getByRole("region", { name: "Before you run" });
    expect(
      within(notices).getByText("Asana Dummy needs reconnect."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Reconnect Asana Dummy" }));
    expect(state.navigateApp).toHaveBeenCalledWith("/servers/srv-asana");
  });

  it("asks for a new choice when a chosen account was removed", () => {
    renderSheet({
      ...emptyPreflight,
      accountProblems: [
        { kind: "removed", serverId: "srv-asana", serverName: "Asana" },
      ],
    });
    expect(
      screen.getByText(
        /An account chosen for Asana was removed\. Choose again in the suite's settings\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
    expect(
      hasBlockingPreflight({
        ...emptyPreflight,
        accountProblems: [
          { kind: "removed", serverId: "srv-asana", serverName: "Asana" },
        ],
      }),
    ).toBe(true);
  });

  it("shows whose accounts the run uses and lets it start", () => {
    renderSheet({
      ...emptyPreflight,
      runsAs: [
        {
          serverId: "srv-asana",
          serverName: "Asana",
          accounts: [{ name: "Dummy", needsReauth: false }],
        },
      ],
    });
    expect(screen.getByTestId("suite-runs-as")).toHaveTextContent(
      "Runs as you · Asana Dummy",
    );
    expect(screen.getByRole("button", { name: "Start run" })).toBeEnabled();
  });

  it("turns the saved choice into the sheet's checks", () => {
    state.view = {
      servers: [
        {
          serverId: "srv-asana",
          mode: "accounts",
          accounts: [live, { ...dummy, needsReauth: true }],
          chosen: ["conn-dummy"],
        },
      ],
      scheduleOwners: [],
    } satisfies SuiteAccountsView;
    const { result } = renderHook(() =>
      useSuiteAccountPreflight({ suite, projectServers }),
    );
    expect(result.current.accountProblems).toEqual([
      {
        kind: "needs_reconnect",
        serverId: "srv-asana",
        serverName: "Asana",
        connectionId: "conn-dummy",
        accountName: "Dummy",
      },
    ]);
    expect(result.current.runsAs).toEqual([
      {
        serverId: "srv-asana",
        serverName: "Asana",
        accounts: [{ name: "Dummy", needsReauth: true }],
      },
    ]);
  });
});
