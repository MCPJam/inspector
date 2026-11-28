import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import { SuiteAccountsRow } from "../suite-accounts-row";
import type { EvalSuite } from "../types";
import type { SuiteAccountsView } from "@/lib/evals/eval-accounts";
import { createWebAccountView } from "@/test/factories";

const state = vi.hoisted(() => ({
  flag: true,
  webFlag: false,
  webAccounts: [] as unknown[],
  webSelections: [] as unknown[] | undefined,
  view: undefined as unknown,
  save: vi.fn(),
  queried: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "eval-account-selection-enabled"
      ? state.flag
      : flag === "web-clients-enabled"
        ? state.webFlag
        : false,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useMutation: () => state.save,
  useQuery: (query: never, args: unknown) => {
    if (args === "skip") return undefined;
    state.queried.push({ name: getFunctionName(query), args });
    return getFunctionName(query) === "webClients:listWebAccounts"
      ? state.webAccounts
      : state.webSelections;
  },
  useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(queries).map(([key, { query, args }]) => {
        state.queried.push({ name: getFunctionName(query), args });
        return [key, state.view];
      }),
    ),
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("@/hooks/useProjects", async (importOriginal) => ({
  shouldQueryProjectId: (
    await importOriginal<typeof import("@/hooks/useProjects")>()
  ).shouldQueryProjectId,
  useProjectServers: () => ({
    servers: [
      { _id: "srv-asana", name: "Asana" },
      { _id: "srv-linear", name: "Linear" },
      { _id: "srv-okta", name: "Okta app" },
      { _id: "srv-tracker", name: "Task tracker" },
    ],
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const suite = {
  _id: "suite-1",
  createdBy: "u1",
  projectId: "project-1",
  name: "Asana task triage",
  description: "",
  configRevision: "1",
  environment: { servers: ["Asana", "Linear", "Okta app"] },
  createdAt: 1,
  updatedAt: 1,
} satisfies EvalSuite;

const live = {
  connectionId: "conn-live",
  name: "Live",
  isDefault: true,
  needsReauth: false,
};
const dummy = {
  connectionId: "conn-dummy",
  name: "Dummy",
  isDefault: false,
  needsReauth: false,
};

function view(overrides: Partial<SuiteAccountsView> = {}): SuiteAccountsView {
  return {
    servers: [
      {
        serverId: "srv-asana",
        mode: "accounts",
        accounts: [live, dummy],
        chosen: null,
      },
    ],
    scheduleOwners: [],
    ...overrides,
  };
}

function renderRow() {
  return render(<SuiteAccountsRow suite={suite} projectId="project-1" />);
}

beforeEach(() => {
  state.flag = true;
  state.webFlag = false;
  state.webAccounts = [];
  state.webSelections = [];
  state.view = view();
  state.save.mockReset();
  state.save.mockResolvedValue(null);
  state.queried = [];
  vi.mocked(toast.success).mockClear();
});

describe("SuiteAccountsRow", () => {
  it("is not shown while the rollout flag is off", () => {
    state.flag = false;
    const { container } = renderRow();
    expect(container).toBeEmptyDOMElement();
    expect(state.queried).toEqual([]);
  });

  it("is not shown for a local project, whose servers are never read", () => {
    const { container } = render(
      <SuiteAccountsRow suite={suite} projectId="local_project" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(state.queried).toEqual([]);
  });

  it("asks for the suite's servers by id and labels the row Accounts", () => {
    renderRow();
    expect(state.queried).toContainEqual({
      name: "testSuiteAccountSelections:getSuiteAccountsView",
      args: {
        suiteId: "suite-1",
        serverIds: ["srv-asana", "srv-linear", "srv-okta"],
      },
    });
    const row = document.querySelector('[data-setting-key="accounts"]');
    expect(row).toHaveTextContent("Accounts");
    expect(row).toHaveTextContent(
      "Choose the accounts your runs use.",
    );
  });

  it("drafts a shared server default through suite settings", async () => {
    state.view = view({ servers: [{
      serverId: "srv-asana",
      mode: "shared",
      managed: true,
      accounts: [live, dummy],
      chosen: [dummy.connectionId],
    }] });
    const edit = vi.fn();
    render(<SuiteAccountsRow suite={suite} projectId="project-1" sharedDefaults={{
      value: [{ serverId: "srv-asana", connectionId: live.connectionId }],
      onChange: edit,
      disabled: false,
    }} />);
    const picker = screen.getByRole("button", { name: /^Asana account/ });
    expect(picker).toHaveTextContent("Live");
    await userEvent.click(picker);
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Dummy/ }));
    expect(edit).toHaveBeenCalledWith([{ serverId: "srv-asana", connectionId: dummy.connectionId }]);
    expect(state.save).not.toHaveBeenCalled();
  });

  it("preselects the default account and keeps it chosen while it is the only one", () => {
    renderRow();
    const mine = screen.getByTestId("suite-accounts-mine");
    expect(within(mine).getByText("Runs as you")).toBeInTheDocument();
    const liveBox = within(mine).getByRole("checkbox", { name: "Asana Live" });
    const dummyBox = within(mine).getByRole("checkbox", { name: "Asana Dummy" });
    expect(liveBox).toBeChecked();
    expect(dummyBox).not.toBeChecked();
    // At least one stays checked: the last one cannot be cleared.
    expect(liveBox).toBeDisabled();
    expect(within(mine).getByText("Default")).toBeInTheDocument();
  });

  it("saves the accounts when one is ticked, and says so", async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole("checkbox", { name: "Asana Dummy" }));
    expect(state.save).toHaveBeenLastCalledWith({
      suiteId: "suite-1",
      serverId: "srv-asana",
      connectionIds: ["conn-live", "conn-dummy"],
    });
    // Save settings stays off for this row, so the toast is the confirmation.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved your Asana accounts."),
    );
  });

  it("saves the accounts when one is cleared, leaving out the default", async () => {
    state.view = view({
      servers: [
        {
          serverId: "srv-asana",
          mode: "accounts",
          accounts: [live, dummy],
          chosen: ["conn-live", "conn-dummy"],
        },
      ],
    });
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole("checkbox", { name: "Asana Live" }));
    expect(state.save).toHaveBeenLastCalledWith({
      suiteId: "suite-1",
      serverId: "srv-asana",
      connectionIds: ["conn-dummy"],
    });
  });

  it("falls back to the saved choice when a save fails", async () => {
    state.save.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole("checkbox", { name: "Asana Dummy" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Could not save your Asana accounts. Try again.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Asana Dummy" })).not.toBeChecked();
  });

  it("shows the backend's reason when it refuses the choice", async () => {
    state.save.mockRejectedValue(
      new ConvexError({ code: "FORBIDDEN", message: "Dummy belongs to another person." }),
    );
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole("checkbox", { name: "Asana Dummy" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenLastCalledWith(
        "Dummy belongs to another person.",
      ),
    );
  });

  it("marks an account that needs reconnecting and a chosen one that was removed", () => {
    state.view = view({
      servers: [
        {
          serverId: "srv-asana",
          mode: "accounts",
          accounts: [live, { ...dummy, needsReauth: true }],
          chosen: ["conn-dummy", "conn-gone"],
        },
      ],
    });
    renderRow();
    const mine = screen.getByTestId("suite-accounts-mine");
    expect(within(mine).getByText("Needs reconnect")).toBeInTheDocument();
    expect(
      within(mine).getByText(
        /An account chosen for Asana was removed\. Choose again\./,
      ),
    ).toBeInTheDocument();
  });

  it("saves the accounts still chosen once a removed one is dropped", async () => {
    state.view = view({
      servers: [
        {
          serverId: "srv-asana",
          mode: "accounts",
          accounts: [live, dummy],
          chosen: ["conn-dummy", "conn-gone"],
        },
      ],
    });
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole("button", { name: "Save this choice" }));
    expect(state.save).toHaveBeenLastCalledWith({
      suiteId: "suite-1",
      serverId: "srv-asana",
      connectionIds: ["conn-dummy"],
    });
  });

  it("shows the project's XAA connection as a fixed row", () => {
    state.view = view({
      servers: [
        {
          serverId: "srv-okta",
          mode: "xaa",
          accounts: [],
          chosen: null,
          xaaSubject: "alice-test",
        },
      ],
    });
    renderRow();
    expect(screen.queryByTestId("suite-accounts-mine")).toBeNull();
    const project = screen.getByTestId("suite-accounts-project");
    expect(within(project).getByText("Project connections")).toBeInTheDocument();
    expect(
      within(project).getByRole("row", {
        name: /Okta app alice-test Simulated identity/,
      }),
    ).toBeInTheDocument();
    expect(within(project).queryByRole("checkbox")).toBeNull();
  });

  describe("a server shared with the project", () => {
    const first = {
      connectionId: "conn-ta1",
      name: "test-automation-1",
      isDefault: true,
      needsReauth: false,
    };
    const second = {
      connectionId: "conn-ta2",
      name: "test-automation-2",
      isDefault: false,
      needsReauth: true,
    };

    it("lists its project accounts as choices beside the person's own", () => {
      state.view = view({
        servers: [
          {
            serverId: "srv-tracker",
            mode: "shared",
            accounts: [first, second],
            chosen: ["conn-ta2"],
          },
        ],
      });
      renderRow();
      expect(screen.queryByTestId("suite-accounts-project")).toBeNull();
      const mine = screen.getByTestId("suite-accounts-mine");
      expect(
        within(mine).getByRole("rowheader", {
          name: "Task tracker Shared with the project",
        }),
      ).toBeInTheDocument();
      expect(
        within(mine).getByRole("checkbox", {
          name: "Task tracker test-automation-1",
        }),
      ).not.toBeChecked();
      expect(
        within(mine).getByRole("checkbox", {
          name: "Task tracker test-automation-2",
        }),
      ).toBeChecked();
      expect(within(mine).getByText("Needs reconnect")).toBeInTheDocument();
    });

    it("saves the project accounts a person chooses", async () => {
      state.view = view({
        servers: [
          {
            serverId: "srv-tracker",
            mode: "shared",
            accounts: [first, { ...second, needsReauth: false }],
            chosen: null,
          },
        ],
      });
      const user = userEvent.setup();
      renderRow();
      await user.click(
        screen.getByRole("checkbox", {
          name: "Task tracker test-automation-2",
        }),
      );
      expect(state.save).toHaveBeenLastCalledWith({
        suiteId: "suite-1",
        serverId: "srv-tracker",
        connectionIds: ["conn-ta1", "conn-ta2"],
      });
    });

    it("says when the project has no account to choose yet", () => {
      state.view = view({
        servers: [
          {
            serverId: "srv-tracker",
            mode: "shared",
            accounts: [],
            chosen: null,
          },
        ],
      });
      renderRow();
      const mine = screen.getByTestId("suite-accounts-mine");
      expect(
        within(mine).getByText(
          "No project account yet. A project admin can connect one on the server's page.",
        ),
      ).toBeInTheDocument();
      expect(
        within(mine).getByRole("button", { name: "Open server" }),
      ).toBeInTheDocument();
    });
  });

  it("lists a schedule owner's accounts read-only", () => {
    state.view = view({
      scheduleOwners: [
        {
          name: "Sophie Lin",
          servers: [{ serverId: "srv-asana", accountNames: ["Dummy"] }],
        },
      ],
    });
    renderRow();
    const owner = screen.getByRole("region", {
      name: "Runs as Sophie Lin · Schedule owner",
    });
    expect(within(owner).getByText("Schedule owner")).toBeInTheDocument();
    expect(
      within(owner).getByText(
        "Used by the schedule Sophie Lin owns. Only Sophie Lin can change these accounts.",
      ),
    ).toBeInTheDocument();
    expect(
      within(owner).getByRole("row", { name: "Asana Dummy" }),
    ).toBeInTheDocument();
    expect(within(owner).queryByRole("checkbox")).toBeNull();
  });

  it("says so when none of the suite's servers use an account", () => {
    state.view = view({
      servers: [
        { serverId: "srv-asana", mode: "none", accounts: [], chosen: null },
      ],
    });
    renderRow();
    expect(
      screen.getByText("None of this suite's servers use an account."),
    ).toBeInTheDocument();
  });
});

describe("SuiteAccountsRow web clients", () => {
  const qa = createWebAccountView({ webAccountId: "wa-qa" });
  const evals = createWebAccountView({
    webAccountId: "wa-evals",
    label: "Evals bot",
    accountEmail: "evals@example.com",
    status: "needs_sign_in",
    isDefault: false,
  });

  it("adds a web clients group behind its own flag, even with server accounts off", async () => {
    state.flag = false;
    state.webFlag = true;
    state.webAccounts = [qa, evals];
    const user = userEvent.setup();
    renderRow();
    expect(screen.queryByTestId("suite-accounts-mine")).toBeNull();
    const group = screen.getByTestId("suite-accounts-web");
    expect(within(group).getByText("Web clients")).toBeInTheDocument();
    expect(
      within(group).getByRole("columnheader", { name: "Client" }),
    ).toBeInTheDocument();
    expect(within(group).queryByText("Server")).toBeNull();
    expect(
      within(group).getByRole("rowheader", { name: "Claude web" }),
    ).toBeInTheDocument();
    expect(within(group).getByText("Needs sign-in")).toBeInTheDocument();
    expect(
      within(group).getByRole("checkbox", { name: "Claude web qa@example.com" }),
    ).toBeChecked();
    await user.click(
      within(group).getByRole("checkbox", {
        name: "Claude web evals@example.com",
      }),
    );
    expect(state.save).toHaveBeenLastCalledWith({
      suiteId: "suite-1",
      vendor: "claude",
      webAccountIds: ["wa-qa", "wa-evals"],
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Saved your Claude web accounts.",
      ),
    );
  });

  it("keeps the choices disabled until the saved choice loads", () => {
    state.flag = false;
    state.webFlag = true;
    state.webAccounts = [qa, evals];
    state.webSelections = undefined;
    renderRow();
    // The default shows checked meanwhile; a click would save over the
    // person's real choice.
    expect(
      within(screen.getByTestId("suite-accounts-web")).getByRole("checkbox", {
        name: "Claude web evals@example.com",
      }),
    ).toBeDisabled();
  });

  it("sits beside the servers' accounts when both flags are on", () => {
    state.webFlag = true;
    state.webAccounts = [qa];
    renderRow();
    expect(screen.getByTestId("suite-accounts-mine")).toBeInTheDocument();
    expect(screen.getByTestId("suite-accounts-web")).toBeInTheDocument();
  });

  it("reads and shows nothing about web accounts while the flag is off", () => {
    state.webAccounts = [qa];
    renderRow();
    expect(screen.queryByTestId("suite-accounts-web")).toBeNull();
    expect(
      state.queried.some(({ name }) => name.startsWith("webClient")),
    ).toBe(false);
  });

  it("stays hidden while the project has no web accounts", () => {
    state.flag = false;
    state.webFlag = true;
    const { container } = renderRow();
    expect(container).toBeEmptyDOMElement();
  });
});
