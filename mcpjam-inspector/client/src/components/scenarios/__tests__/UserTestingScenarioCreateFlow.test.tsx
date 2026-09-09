/**
 * `/user-testing/new`, environment-first and TWO steps (BB-176).
 *
 * What this pins:
 *  - nothing is written until Create study — Continue only moves the stepper —
 *    and the publish is ONE call carrying the name and the access mode (so a
 *    scenario is never briefly live in a mode nobody asked for);
 *  - step 1 arrives ANSWERED: a client is preselected and the name is
 *    suggested off it, so Continue is pressable without typing, and an empty
 *    name is not a wall;
 *  - the access default is the least-exposed option;
 *  - the name follows the picked environment until the user types, then stops;
 *  - step 2 authors the tester's task list, and Create study carries it — with
 *    ratings — in a single second write;
 *  - an already-published environment is reported as such rather than as a
 *    failure, and keeps its own ratings and tasks;
 *  - the flow never CREATES an environment — it hands off to the Environments
 *    editor with the typed name seeded.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import type { HostListItem } from "@/hooks/useClients";

const {
  environmentsState,
  flagState,
  hostListState,
  saveSeedMock,
  toastSuccess,
  toastError,
  ensureAdhocMock,
} = vi.hoisted(() => ({
  environmentsState: {
    value: undefined as ProjectEnvironmentView[] | undefined,
  },
  flagState: { environments: true },
  hostListState: {
    hosts: [] as Array<Partial<HostListItem>>,
    isLoading: false,
  },
  saveSeedMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  ensureAdhocMock: vi.fn(),
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => environmentsState.value,
  useEnsureAdhocEnvironments: () => ensureAdhocMock,
}));

// The composer's own slots. `project-environments-enabled` defaults on so its
// saved-env row renders; the flag-off suite at the bottom flips it, because
// this flow is now the ONLY create flow and has to work either way. The other
// two stay off, keeping the strip to clients + server group.
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => flagState.environments,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => false,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => hostListState,
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => <div data-testid="server-group-picker" />,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

const sharePolicyState = vi.hoisted(() => ({
  policy: undefined as
    | {
        maxShareMode: "project_members" | "invited_only" | "anyone_with_link";
        inviteAudience: "anyone" | "org_members";
        updatedAt: number | null;
      }
    | undefined,
}));

vi.mock("@/hooks/useOrgSharePolicy", () => ({
  useEffectiveSharePolicy: () => ({
    policy: sharePolicyState.policy,
    isLoading: false,
  }),
}));
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  routePaths: { hosts: "/hosts", environments: "/environments" },
}));

vi.mock("@/lib/environment-draft-seed", () => ({
  saveEnvironmentDraftSeed: saveSeedMock,
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

// Pure presentation in the real thing; stubbed to a plain select so the test
// drives selection without Radix portals.
vi.mock("@/components/project-environments/environment-picker", () => ({
  EnvironmentPicker: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (next: string | null) => void;
  }) => (
    <select
      data-testid="user-testing-create-environment"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">none</option>
      <option value="env-1">Checkout flow</option>
      <option value="env-2">Onboarding</option>
    </select>
  ),
}));

import {
  UserTestingScenarioCreateFlow,
  composedSetupHasServers,
  pickDefaultCreateClient,
} from "@/components/scenarios/UserTestingScenarioCreateFlow";

const env = (over: Partial<ProjectEnvironmentView>): ProjectEnvironmentView =>
  ({
    environmentId: "env-1",
    projectId: "p1",
    name: "Checkout flow",
    hostId: "host-1",
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as ProjectEnvironmentView;

function renderFlow(
  onCreateScenario = vi.fn().mockResolvedValue({
    scenarioId: "cb-1",
    created: true,
  }),
  onCreateEnvironment = vi.fn(),
  onApplyStudySurfaces = vi.fn().mockResolvedValue(undefined),
) {
  render(
    <UserTestingScenarioCreateFlow
      projectId="p1"
      onCancel={vi.fn()}
      onCreateEnvironment={onCreateEnvironment}
      onCreateScenario={onCreateScenario}
      onApplyStudySurfaces={onApplyStudySurfaces}
    />,
  );
  return { onCreateScenario, onCreateEnvironment, onApplyStudySurfaces };
}

/** Step 1 → step 2. Every write lives behind this. */
function goToTasks() {
  fireEvent.click(screen.getByTestId("user-testing-create-continue"));
}

/** Step 1 → step 2 → publish, for the tests that are not about the stepper. */
function createStudy() {
  goToTasks();
  fireEvent.click(screen.getByTestId("user-testing-create-save"));
}

beforeEach(() => {
  vi.clearAllMocks();
  sharePolicyState.policy = undefined;
  flagState.environments = true;
  // `serverCount` matters: a client with none composes an environment that
  // resolves to zero servers, which the screen now refuses to publish.
  hostListState.hosts = [
    { hostId: "host-1", name: "Claude", serverCount: 2 },
    { hostId: "host-2", name: "Cursor", serverCount: 1 },
  ];
  hostListState.isLoading = false;
  ensureAdhocMock.mockImplementation(
    async (args: { stacks: Array<{ hostId: string }> }) =>
      args.stacks.map((stack) => ({
        // Nameless, like every ad-hoc row.
        environment: env({
          environmentId: `adhoc-${stack.hostId}`,
          name: undefined,
          origin: "adhoc",
          hostId: stack.hostId,
        }),
        created: true,
      })),
  );
  environmentsState.value = [
    env({}),
    env({ environmentId: "env-2", name: "Onboarding" }),
  ];
});

describe("pickDefaultCreateClient", () => {
  it("prefers MCPJam's own client", () => {
    // The one host every project is guaranteed to be able to run.
    const picked = pickDefaultCreateClient([
      { hostId: "a", name: "Claude", updatedAt: 99 } as HostListItem,
      {
        hostId: "b",
        name: "MCPJam",
        hostStyle: "mcpjam",
        updatedAt: 1,
      } as HostListItem,
    ]);
    expect(picked?.hostId).toBe("b");
  });

  it("falls back to the most recently touched client", () => {
    const picked = pickDefaultCreateClient([
      { hostId: "a", name: "Claude", updatedAt: 5 } as HostListItem,
      { hostId: "b", name: "Cursor", updatedAt: 50 } as HostListItem,
    ]);
    expect(picked?.hostId).toBe("b");
  });

  it("has nothing to pick in a project with no clients", () => {
    expect(pickDefaultCreateClient([])).toBeNull();
  });
});

describe("UserTestingScenarioCreateFlow", () => {
  beforeEach(() => {
    sharePolicyState.policy = undefined;
  });

  it("writes nothing until Create study, then publishes in ONE call", async () => {
    const { onCreateScenario } = renderFlow();

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    expect(onCreateScenario).not.toHaveBeenCalled();

    // Continue only moves the stepper — leaving from step 2 must leave nothing
    // behind, which is the whole reason this is not a two-write flow.
    goToTasks();
    expect(onCreateScenario).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    await waitFor(() => {
      expect(onCreateScenario).toHaveBeenCalledTimes(1);
    });
    expect(onCreateScenario).toHaveBeenCalledWith({
      environmentId: "env-1",
      name: "Checkout flow",
      // Least-exposed default, carried in the same call as the publish.
      mode: "invited_only",
    });
  });

  it("cannot continue without an environment", () => {
    // No clients to default to, so nothing answers the required field.
    hostListState.hosts = [];
    renderFlow();
    expect(screen.getByTestId("user-testing-create-continue")).toBeDisabled();
  });

  /**
   * The gate above is old; SAYING so is the fix. It was reported as "I can
   * create a scenario without an environment" precisely because the only sign
   * was an inert button — so the requirement is stated on the field, and drops
   * away once the field is satisfied rather than nagging under a valid form.
   */
  it("says the environment is required, and stops saying it once one is picked", () => {
    hostListState.hosts = [];
    renderFlow();

    expect(
      screen.getByTestId("user-testing-create-environment-required"),
    ).toBeInTheDocument();
    // Marked on the label too — an asterisk is what a scanning user reads as
    // "required" before they try Continue.
    expect(screen.getAllByText("(required)").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });

    expect(
      screen.queryByTestId("user-testing-create-environment-required"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-create-continue"),
    ).not.toBeDisabled();
  });

  it("waits for the environment list before claiming anything is missing", () => {
    // `undefined` is "we haven't looked yet" — the loading line is the honest
    // answer there, and asserting a missing field would contradict it.
    environmentsState.value = undefined;
    hostListState.hosts = [];
    renderFlow();

    expect(
      screen.queryByTestId("user-testing-create-environment-required"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-create-environments-loading"),
    ).toBeInTheDocument();
  });

  it("names the scenario after the environment until the user types", () => {
    renderFlow();
    const picker = screen.getByTestId("user-testing-create-environment");

    fireEvent.change(picker, { target: { value: "env-1" } });
    expect(screen.getByTestId("user-testing-create-name")).toHaveValue(
      "Checkout flow",
    );

    // Switching before typing keeps tracking...
    fireEvent.change(picker, { target: { value: "env-2" } });
    expect(screen.getByTestId("user-testing-create-name")).toHaveValue(
      "Onboarding",
    );

    // ...and a typed name is never overwritten.
    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Round 2 with real users" },
    });
    fireEvent.change(picker, { target: { value: "env-1" } });
    expect(screen.getByTestId("user-testing-create-name")).toHaveValue(
      "Round 2 with real users",
    );
  });

  it("reports an already-published environment as such, not as a failure", async () => {
    const onCreateScenario = vi
      .fn()
      .mockResolvedValue({ scenarioId: "cb-9", created: false });
    renderFlow(onCreateScenario);

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    createStudy();

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/already published/i),
      );
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces the backend's message verbatim when publishing is refused", async () => {
    // Publishing is project-admin gated: "you need admin" and "it broke" send
    // the user to different places.
    const onCreateScenario = vi
      .fn()
      .mockRejectedValue(
        new Error("Publishing an environment scenario requires project admin."),
      );
    renderFlow(onCreateScenario);

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    createStudy();

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Publishing an environment scenario requires project admin.",
      );
    });
    // Recoverable — the form is usable again rather than stuck mid-save.
    expect(screen.getByTestId("user-testing-create-save")).not.toBeDisabled();
  });

  it("hands off to the Environments editor instead of creating one here", () => {
    const { onCreateEnvironment } = renderFlow();

    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Checkout, take three" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-new-environment"));

    // Scenario surfaces select environments; only Swarms materializes them.
    // The typed name rides along so the round trip doesn't cost it.
    expect(saveSeedMock).toHaveBeenCalledWith("p1", {
      name: "Checkout, take three",
      hostId: null,
      serverAttachmentId: null,
      skillSelection: null,
    });
    expect(onCreateEnvironment).toHaveBeenCalled();
  });

  it("is not a dead end when the project has no environments", () => {
    environmentsState.value = [];
    renderFlow();

    // The old blocking "no environments yet" card is gone: an empty project can
    // compose the environment it needs right here.
    expect(
      screen.queryByTestId("user-testing-create-no-environments"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-create-clients-picker"),
    ).toBeInTheDocument();
    // Curating a named one is still one click away.
    expect(
      screen.getByTestId("user-testing-create-new-environment"),
    ).toBeInTheDocument();
  });
});

/**
 * BB-176: step 1 answers itself.
 *
 * Research watched someone stall on naming a study, and again on an empty
 * client picker — "People block when you're making them name things", "Here
 * you don't have a default client picked", "Don't put that in my way".
 */
/**
 * A study whose environment resolves to no servers is created fine and then
 * refuses to open — the creator gets "This scenario can't be opened right
 * now", the tester gets "This link isn't available right now", and neither
 * names the cause. Publish is the last place that can still prevent it.
 */
describe("UserTestingScenarioCreateFlow — a setup with no servers", () => {
  it("prefers a client that has servers when defaulting", () => {
    // A default that walks the creator into an unopenable study is worse than
    // no default at all.
    const picked = pickDefaultCreateClient([
      {
        hostId: "a",
        name: "Empty",
        serverCount: 0,
        updatedAt: 99,
      } as HostListItem,
      {
        hostId: "b",
        name: "Loaded",
        serverCount: 1,
        updatedAt: 1,
      } as HostListItem,
    ]);
    expect(picked?.hostId).toBe("b");
  });

  it("prefers MCPJam only among clients that can run", () => {
    const picked = pickDefaultCreateClient([
      {
        hostId: "a",
        name: "MCPJam",
        hostStyle: "mcpjam",
        serverCount: 0,
        updatedAt: 1,
      } as HostListItem,
      {
        hostId: "b",
        name: "Cursor",
        serverCount: 3,
        updatedAt: 2,
      } as HostListItem,
    ]);
    expect(picked?.hostId).toBe("b");
  });

  it("still fills the strip when NO client has servers", () => {
    // The gate on the screen explains what is missing; returning null here
    // would leave the creator with an empty form and no reason given.
    const picked = pickDefaultCreateClient([
      {
        hostId: "a",
        name: "Empty",
        serverCount: 0,
        updatedAt: 1,
      } as HostListItem,
    ]);
    expect(picked?.hostId).toBe("a");
  });

  it("distinguishes 'no servers' from 'do not know yet'", () => {
    const hosts = [
      { hostId: "host-1", name: "Empty", serverCount: 0 } as HostListItem,
      { hostId: "host-2", name: "Loaded", serverCount: 2 } as HostListItem,
    ];
    const ask = (
      over: Partial<Parameters<typeof composedSetupHasServers>[0]>,
    ) =>
      composedSetupHasServers({
        serverAttachmentId: null,
        hostId: "host-1",
        hosts,
        hostsLoading: false,
        ...over,
      });

    expect(ask({})).toBe(false);
    expect(ask({ hostId: "host-2" })).toBe(true);
    // A server group carries its own servers, whatever the client has.
    expect(ask({ serverAttachmentId: "att_1" })).toBe(true);
    // Unknown, not broken: nothing picked, still loading, or a client the
    // list has not caught up with.
    expect(ask({ hostId: null })).toBeNull();
    expect(ask({ hostsLoading: true })).toBeNull();
    expect(ask({ hostId: "host-unknown" })).toBeNull();
  });

  it("refuses to publish, and says what is missing", () => {
    hostListState.hosts = [
      { hostId: "host-1", name: "Claude", serverCount: 0 },
    ];
    renderFlow();

    expect(
      screen.getByTestId("user-testing-create-servers-required"),
    ).toHaveTextContent(/no servers of its own/i);
    expect(screen.getByTestId("user-testing-create-continue")).toBeDisabled();
  });

  it("says nothing while the host list has not settled, and lets nothing through", () => {
    // An unknown answer must not render as a problem — but it must not open
    // the gate either. The server question answers `null` during the load
    // window, and a fast creator could otherwise publish straight through it.
    hostListState.hosts = [];
    hostListState.isLoading = true;
    renderFlow();

    expect(
      screen.queryByTestId("user-testing-create-servers-required"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("user-testing-create-continue")).toBeDisabled();
  });

  it("never lands the default on the broken client when a runnable one exists", () => {
    // The end-to-end shape of the fix: in a mixed project the creator never
    // sees the problem, because the default skips the client that cannot run.
    hostListState.hosts = [
      { hostId: "host-1", name: "Empty", serverCount: 0, updatedAt: 99 },
      { hostId: "host-2", name: "Loaded", serverCount: 2, updatedAt: 1 },
    ];
    renderFlow();

    expect(screen.getByTestId("user-testing-create-name")).toHaveValue(
      "Loaded",
    );
    expect(
      screen.queryByTestId("user-testing-create-servers-required"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-create-continue"),
    ).not.toBeDisabled();
  });

  it("blocks a picked client that cannot run, even in a mixed project", () => {
    hostListState.hosts = [
      { hostId: "host-1", name: "Empty", serverCount: 0 },
      { hostId: "host-2", name: "Loaded", serverCount: 2 },
    ];
    renderFlow();

    // Deliberately switching TO the empty one: the gate follows the pick, not
    // just the default.
    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^empty$/i }));

    expect(
      screen.getByTestId("user-testing-create-servers-required"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("user-testing-create-continue")).toBeDisabled();
  });
});

describe("UserTestingScenarioCreateFlow — defaults", () => {
  it("preselects a client and suggests a name, so Continue is pressable on arrival", () => {
    renderFlow();

    expect(screen.getByTestId("user-testing-create-name")).toHaveValue(
      "Claude",
    );
    expect(
      screen.getByTestId("user-testing-create-continue"),
    ).not.toBeDisabled();
    expect(
      screen.queryByTestId("user-testing-create-environment-required"),
    ).not.toBeInTheDocument();
  });

  it("waits for the host list to settle before deciding there is nothing to default to", () => {
    // Mid-load the list reads as empty; defaulting off that would pick nothing
    // and then never try again.
    hostListState.hosts = [];
    hostListState.isLoading = true;
    const { onCreateScenario } = renderFlow();

    expect(screen.getByTestId("user-testing-create-continue")).toBeDisabled();
    expect(onCreateScenario).not.toHaveBeenCalled();
  });

  it("does not fight a creator who picked something else", () => {
    renderFlow();

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-2" },
    });

    expect(screen.getByTestId("user-testing-create-name")).toHaveValue(
      "Onboarding",
    );
  });

  it("selects the suggested name on first focus, so typing replaces it", () => {
    // The prefill is real text, not a placeholder. Without this the creator has
    // to clear it before writing their own name — the thing that made the old
    // prefill read as junk.
    renderFlow();
    const field = screen.getByTestId(
      "user-testing-create-name",
    ) as HTMLInputElement;
    const select = vi.spyOn(field, "select");

    fireEvent.focus(field);
    expect(select).toHaveBeenCalledTimes(1);

    // Only the FIRST focus: someone who came back to fix a typo must not lose
    // their work on the next keypress.
    fireEvent.change(field, { target: { value: "My own name" } });
    fireEvent.focus(field);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("treats an emptied name as the suggestion, not as a wall", async () => {
    const { onCreateScenario } = renderFlow();

    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "" },
    });
    expect(
      screen.getByTestId("user-testing-create-continue"),
    ).not.toBeDisabled();

    createStudy();

    await waitFor(() => expect(onCreateScenario).toHaveBeenCalled());
    // Never an empty name in the database: the field may be empty, the study
    // may not.
    expect(onCreateScenario.mock.calls[0][0].name).toBe("Claude");
  });
});

/**
 * BB-176 step 2: the "what to try" list a tester sees in their own header.
 * A LIST, not a wizard — empty is fine, and Create study is the way past it.
 */
describe("UserTestingScenarioCreateFlow — tasks step", () => {
  it("moves between the two steps without losing step 1", () => {
    renderFlow();

    goToTasks();
    expect(
      screen.getByRole("heading", { name: /what should they try/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("user-testing-create-name"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("user-testing-create-back-step"));
    expect(screen.getByTestId("user-testing-create-name")).toHaveValue(
      "Claude",
    );
  });

  it("carries the authored tasks and the ratings choice in one second write", async () => {
    const { onApplyStudySurfaces } = renderFlow();

    goToTasks();
    fireEvent.change(screen.getByTestId("user-testing-create-task-title-0"), {
      target: { value: "  Find last month's unpaid invoices  " },
    });
    fireEvent.change(screen.getByTestId("user-testing-create-task-hint-0"), {
      target: { value: "Any customer" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-task-add"));
    fireEvent.change(screen.getByTestId("user-testing-create-task-title-1"), {
      target: { value: "Draft a reminder" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    await waitFor(() => expect(onApplyStudySurfaces).toHaveBeenCalledTimes(1));
    const [scenarioId, surfaces] = onApplyStudySurfaces.mock.calls[0];
    expect(scenarioId).toBe("cb-1");
    expect(surfaces.perTurnFeedback).toEqual({
      enabled: true,
      style: "stars",
    });
    expect(surfaces.tasks.items.map((t: { title: string }) => t.title)).toEqual(
      ["Find last month's unpaid invoices", "Draft a reminder"],
    );
    expect(surfaces.tasks.items[0].hint).toBe("Any customer");
  });

  it("skipping the step persists no tasks rather than an empty row", async () => {
    // The step opens on one empty row so it reads as a list you add to; an
    // untouched row is not a task.
    const { onApplyStudySurfaces } = renderFlow();

    createStudy();

    await waitFor(() => expect(onApplyStudySurfaces).toHaveBeenCalled());
    expect(onApplyStudySurfaces.mock.calls[0][1].tasks).toEqual({ items: [] });
  });

  it("caps the list and says why, rather than silently dropping rows", () => {
    renderFlow();
    goToTasks();

    for (let i = 0; i < 4; i += 1) {
      fireEvent.change(
        screen.getByTestId(`user-testing-create-task-title-${i}`),
        { target: { value: `Task ${i}` } },
      );
      fireEvent.click(screen.getByTestId("user-testing-create-task-add"));
    }
    fireEvent.change(screen.getByTestId("user-testing-create-task-title-4"), {
      target: { value: "Task 4" },
    });

    expect(
      screen.queryByTestId("user-testing-create-task-add"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-create-task-limit"),
    ).toBeInTheDocument();
  });

  it("removes a row without disturbing the others", () => {
    renderFlow();
    goToTasks();

    fireEvent.change(screen.getByTestId("user-testing-create-task-title-0"), {
      target: { value: "Keep me" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-task-add"));
    fireEvent.change(screen.getByTestId("user-testing-create-task-title-1"), {
      target: { value: "Drop me" },
    });

    fireEvent.click(screen.getByTestId("user-testing-create-task-remove-1"));

    expect(screen.getByTestId("user-testing-create-task-title-0")).toHaveValue(
      "Keep me",
    );
    expect(
      screen.queryByTestId("user-testing-create-task-title-1"),
    ).not.toBeInTheDocument();
  });

  it("offers the detail field only once a task has a title", () => {
    // A detail with nothing to detail is noise.
    renderFlow();
    goToTasks();

    expect(
      screen.queryByTestId("user-testing-create-task-hint-0"),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("user-testing-create-task-title-0"), {
      target: { value: "Try search" },
    });

    expect(
      screen.getByTestId("user-testing-create-task-hint-0"),
    ).toBeInTheDocument();
  });
});

/**
 * Compose mode: the scenario's environment can be built here instead of picked,
 * which is what makes "publish this same setup on another client" one click.
 */
describe("UserTestingScenarioCreateFlow — composing a setup", () => {
  it("resolves the composed client into a row, then publishes THAT", async () => {
    const { onCreateScenario } = renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));
    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Cursor checkout" },
    });

    createStudy();

    await waitFor(() => expect(ensureAdhocMock).toHaveBeenCalledTimes(1));
    expect(ensureAdhocMock).toHaveBeenCalledWith({
      projectId: "p1",
      stacks: [{ hostId: "host-2" }],
    });
    expect(onCreateScenario).toHaveBeenCalledWith({
      environmentId: "adhoc-host-2",
      name: "Cursor checkout",
      mode: "invited_only",
    });
  });

  it("is a single-target surface: picking a client replaces the last one", async () => {
    renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));
    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));
    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Cursor checkout" },
    });
    createStudy();

    // A scenario runs in exactly one environment — never two stacks.
    await waitFor(() => expect(ensureAdhocMock).toHaveBeenCalledTimes(1));
    expect(ensureAdhocMock).toHaveBeenCalledWith({
      projectId: "p1",
      stacks: [{ hostId: "host-2" }],
    });
  });

  /**
   * The client is what a composed setup HAS to be named after. Leaving the
   * field empty was survivable while composing was the exotic path; it is the
   * only path a flag-off project has, and it met that project with a required
   * field nothing fills.
   */
  it("names the scenario after the picked client until the user types", () => {
    renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));
    expect(screen.getByTestId("user-testing-create-name")).toHaveValue(
      "Cursor",
    );
    expect(
      screen.getByTestId("user-testing-create-continue"),
    ).not.toBeDisabled();

    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Round 2 with real users" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));
    expect(screen.getByTestId("user-testing-create-name")).toHaveValue(
      "Round 2 with real users",
    );
  });

  it("lets an empty project compose instead of dead-ending on the handoff", () => {
    environmentsState.value = [];
    renderFlow();

    expect(
      screen.queryByTestId("user-testing-create-no-environments"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-create-clients-picker"),
    ).toBeInTheDocument();
  });

  it("reuses a curated environment the composed setup already matches", async () => {
    const { onCreateScenario } = renderFlow();

    // Claude IS env-1's client, with the same (empty) shared slots — publishing
    // an unnamed twin beside it would strand the scenario on a nameless row.
    // It is also the preselected default, so this is the ordinary path.
    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Reuse me" },
    });
    createStudy();

    await waitFor(() => expect(onCreateScenario).toHaveBeenCalled());
    expect(ensureAdhocMock).not.toHaveBeenCalled();
    expect(onCreateScenario.mock.calls[0][0].environmentId).toBe("env-1");
  });

  it("says an identical setup reopens the scenario it already has", async () => {
    const alreadyPublished = vi
      .fn()
      .mockResolvedValue({ scenarioId: "cb-9", created: false });
    renderFlow(alreadyPublished);

    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));
    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Another go" },
    });
    createStudy();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    // The typed name is dropped by the idempotent publish — say so rather than
    // claiming a scenario was created with it.
    expect(toastSuccess.mock.calls[0][0]).toMatch(/already published/i);
    expect(toastSuccess.mock.calls[0][0]).toMatch(/name and access/i);
  });

  it("degrades to the saved-environment path on a backend without ad-hoc rows", async () => {
    ensureAdhocMock.mockRejectedValue(
      Object.assign(new Error("Could not find public function"), {
        data: "Could not find public function for 'projectEnvironments:ensureAdhocEnvironments'",
      }),
    );
    const { onCreateScenario } = renderFlow();

    // Cursor has no curated environment to fall back on, so this genuinely
    // needs the mutation the old backend lacks.
    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));
    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Cursor checkout" },
    });
    createStudy();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Never a named row behind the user's back, and never a half-made scenario.
    expect(onCreateScenario).not.toHaveBeenCalled();
    expect(toastError.mock.calls[0][0]).toMatch(/pick a saved environment/i);
    // Still retryable — the button is not left spinning.
    expect(screen.getByTestId("user-testing-create-save")).not.toBeDisabled();
  });
});

/**
 * Flag-off, this is still the create flow — there is no other one any more.
 *
 * The composer only gates its SAVED-environment picker on
 * `project-environments-enabled`; clients and the server group are what a
 * flag-off project has always seen in Swarms. That is the whole point of
 * deleting the single-server form: a scenario can now reach a group of servers,
 * and its setup stays editable afterwards.
 */
describe("UserTestingScenarioCreateFlow — without Project Environments", () => {
  beforeEach(() => {
    flagState.environments = false;
  });

  it("composes a scenario from a client and publishes the row it resolves to", async () => {
    const { onCreateScenario } = renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));

    // Named after the client, so Continue is reachable without typing.
    expect(screen.getByTestId("user-testing-create-name")).toHaveValue(
      "Cursor",
    );
    createStudy();

    await waitFor(() => expect(onCreateScenario).toHaveBeenCalledTimes(1));
    expect(ensureAdhocMock).toHaveBeenCalledWith({
      projectId: "p1",
      stacks: [{ hostId: "host-2" }],
    });
    expect(onCreateScenario).toHaveBeenCalledWith({
      environmentId: "adhoc-host-2",
      name: "Cursor",
      mode: "invited_only",
    });
  });

  it("offers the server group — the reason this replaced the one-server form", () => {
    renderFlow();
    expect(screen.getByTestId("server-group-picker")).toBeInTheDocument();
  });

  it("hides the parts of the surface a flag-off project cannot reach", () => {
    renderFlow();

    // No saved-environment picker...
    expect(
      screen.queryByTestId("user-testing-create-environment"),
    ).not.toBeInTheDocument();
    // ...and no handoff to `/environments`, which the route guard bounces. A
    // link to nowhere is worse than no link.
    expect(
      screen.queryByTestId("user-testing-create-new-environment"),
    ).not.toBeInTheDocument();
  });

  it("asks for a client rather than for an environment nobody can pick", () => {
    hostListState.hosts = [];
    renderFlow();

    expect(
      screen.getByTestId("user-testing-create-environment-required"),
    ).toHaveTextContent(/pick the client a tester will see/i);
  });
});

/**
 * BB-126: create-study copy, and the per-turn ratings choice moved forward from
 * post-create settings into the screen that publishes the study.
 */
describe("UserTestingScenarioCreateFlow — create study (Production Redesign)", () => {
  it("uses the frame's chrome and study language", () => {
    renderFlow();

    expect(
      screen.getByRole("heading", { name: /create a new study/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /users try your server in chatgpt, claude, or another client/i,
      ),
    ).toBeVisible();
    const back = screen.getByTestId("user-testing-create-back");
    expect(back).toHaveTextContent("User Testing");
    // The chevron the Swarms create flow uses, not an arrow. Asserted because
    // the whole point of the glyph is that the two flows match.
    expect(back.querySelector("svg.lucide-chevron-left")).not.toBeNull();
    // Labelled, but NOT announced as required: the field accepts empty and
    // falls back to the suggestion, so a required marker would contradict the
    // behaviour for anyone who hears it rather than sees the asterisk.
    const nameField = screen.getByLabelText(/^study name$/i);
    expect(nameField).toBeInTheDocument();
    expect(nameField).not.toHaveAttribute("aria-required");
    expect(
      screen.getByTestId("user-testing-create-continue"),
    ).toHaveTextContent("Continue");
  });

  it("wears Swarm's stepper, naming both steps", () => {
    // Two sibling create flows reached the same way should not disagree about
    // what "you are here" looks like.
    renderFlow();

    const stepper = screen.getByTestId("user-testing-create-progress");
    expect(stepper).toHaveTextContent("Set up study");
    expect(stepper).toHaveTextContent("Create tasks");
  });

  it("names the target strip for the choice, flag on or off", () => {
    // It used to read "Environment" flag-on and "Where it runs" flag-off, which
    // made one control two different things depending on a flag.
    renderFlow();
    expect(
      screen.getByText(/choose the client and servers your users will/i),
    ).toBeVisible();

    flagState.environments = false;
    render(
      <UserTestingScenarioCreateFlow
        projectId="p1"
        onCancel={vi.fn()}
        onCreateEnvironment={vi.fn()}
        onCreateScenario={vi.fn()}
        onApplyStudySurfaces={vi.fn()}
      />,
    );
    expect(
      screen.getAllByText(/choose the client and servers your users will/i),
    ).toHaveLength(2);
  });

  it("offers per-turn ratings on by default, with stars selected", () => {
    renderFlow();

    const toggle = screen.getByTestId("user-testing-create-ratings");
    expect(toggle).toBeChecked();
    expect(
      screen.getByText(/testers will be able to rate each response/i),
    ).toBeVisible();
    expect(
      screen.getByRole("radio", { name: "1-5 Star Ratings" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radio", { name: "Thumbs-Up/Down Ratings" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("hides the style choice while ratings are off", () => {
    // A widget style is a question about a widget nobody is being shown.
    renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-ratings"));
    expect(
      screen.queryByTestId("user-testing-create-rating-style"),
    ).not.toBeInTheDocument();
  });

  it("marks the selected rating style with more than a background tint", () => {
    // Reported from research: in dark mode the selected pill was a ~2%
    // lightness difference with no outline, so nobody could tell which style
    // was picked. The signal must not rest on the fill alone.
    renderFlow();

    const selected = screen.getByRole("radio", { name: "1-5 Star Ratings" });
    expect(selected.className).toMatch(/\bborder-border\b/);
    expect(selected.className).toMatch(/\bfont-semibold\b/);
    expect(
      screen.getByTestId("user-testing-create-rating-style").className,
    ).toMatch(/\bbg-muted\b/);
  });

  it("applies the ratings choice to the study it just created", async () => {
    const { onApplyStudySurfaces } = renderFlow();

    fireEvent.click(screen.getByRole("radio", { name: /thumbs/i }));
    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    createStudy();

    await waitFor(() => {
      expect(onApplyStudySurfaces).toHaveBeenCalledWith("cb-1", {
        perTurnFeedback: { enabled: true, style: "thumbs" },
        tasks: { items: [] },
      });
    });
  });

  it("leaves an already-published study's ratings and tasks alone", async () => {
    // Publishing is idempotent per environment, so a collision opens someone
    // else's study — rewriting its rating widget or replacing its task list
    // from here would reconfigure it.
    const { onApplyStudySurfaces } = renderFlow(
      vi.fn().mockResolvedValue({ scenarioId: "cb-existing", created: false }),
    );

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    createStudy();

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
    });
    expect(onApplyStudySurfaces).not.toHaveBeenCalled();
  });

  it("keeps the study when only the settings write fails, and says which half", async () => {
    const { onApplyStudySurfaces } = renderFlow(
      undefined,
      undefined,
      vi.fn().mockRejectedValue(new Error("nope")),
    );

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    createStudy();

    await waitFor(() => {
      expect(onApplyStudySurfaces).toHaveBeenCalled();
    });
    // The study exists, so this is not reported as a failed creation.
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/study created, but its ratings and task list/i),
    );
    // And it is not ALSO reported as a plain success: that error already opens
    // with "Study created", so a success toast beside it would make the screen
    // say two things about one outcome.
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("UserTestingScenarioCreateFlow — ratings turned off", () => {
  it("persists the disabled setting rather than leaving it to the backend default", async () => {
    // The backend default is already `false`, but writing it explicitly is what
    // makes the study's setting a statement the creator made, not an absence.
    const { onApplyStudySurfaces } = renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-ratings"));
    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    createStudy();

    await waitFor(() => {
      expect(onApplyStudySurfaces).toHaveBeenCalledWith("cb-1", {
        perTurnFeedback: { enabled: false, style: "stars" },
        tasks: { items: [] },
      });
    });
  });
});

describe("UserTestingScenarioCreateFlow — org share ceiling", () => {
  it("snaps the access preset down to the org ceiling and greys over-ceiling options", async () => {
    const user = userEvent.setup();
    sharePolicyState.policy = {
      maxShareMode: "project_members",
      inviteAudience: "anyone",
      updatedAt: 1,
    };
    const { onCreateScenario } = renderFlow();

    expect(
      screen.getByText("Your organization limits sharing to team members."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("user-testing-create-access")).toHaveTextContent(
      "Team members",
    );

    await user.click(screen.getByTestId("user-testing-create-access"));
    expect(
      await screen.findByRole("menuitemradio", {
        name: "Anyone with the link",
      }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitemradio", { name: "Invited users only" }),
    ).toHaveAttribute("data-disabled");

    await user.keyboard("{Escape}");
    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    createStudy();

    await waitFor(() => {
      expect(onCreateScenario).toHaveBeenCalledWith({
        environmentId: "env-1",
        name: "Checkout flow",
        mode: "project_members",
      });
    });
  });
});
