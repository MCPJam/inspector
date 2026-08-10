/**
 * `/user-testing/new`, environment-first.
 *
 * What this pins:
 *  - nothing is written until Save, and Save is ONE call carrying the name and
 *    the access mode (so a scenario is never briefly live in a mode nobody
 *    asked for);
 *  - the access default is the least-exposed option;
 *  - the name follows the picked environment until the user types, then stops;
 *  - an already-published environment is reported as such rather than as a
 *    failure;
 *  - the flow never CREATES an environment — it hands off to the Environments
 *    editor with the typed name seeded.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const {
  environmentsState,
  saveSeedMock,
  toastSuccess,
  toastError,
  ensureAdhocMock,
  composeFlag,
} = vi.hoisted(() => ({
  environmentsState: {
    value: undefined as ProjectEnvironmentView[] | undefined,
  },
  saveSeedMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  ensureAdhocMock: vi.fn(),
  /** `environments-adhoc-enabled` — off by default, so the saved-environment
   * path stays the one every existing case exercises. */
  composeFlag: { current: false },
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => environmentsState.value,
  useEnsureAdhocEnvironments: () => ensureAdhocMock,
}));

vi.mock("@/hooks/useAdhocEnvironmentsEnabled", () => ({
  useAdhocEnvironmentsEnabled: () => composeFlag.current,
}));

// The composer's own slots. `project-environments-enabled` on so its saved-env
// row renders; the other two off, keeping the strip to clients + server group.
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => false,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      { hostId: "host-1", name: "Claude" },
      { hostId: "host-2", name: "Cursor" },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => <div data-testid="server-group-picker" />,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
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

import { UserTestingScenarioCreateFlow } from "@/components/chatboxes/UserTestingScenarioCreateFlow";

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
  } as ProjectEnvironmentView);

function renderFlow(
  onCreateScenario = vi.fn().mockResolvedValue({
    scenarioId: "cb-1",
    created: true,
  }),
  onCreateEnvironment = vi.fn(),
) {
  render(
    <UserTestingScenarioCreateFlow
      projectId="p1"
      onCancel={vi.fn()}
      onCreateEnvironment={onCreateEnvironment}
      onCreateScenario={onCreateScenario}
    />,
  );
  return { onCreateScenario, onCreateEnvironment };
}

beforeEach(() => {
  vi.clearAllMocks();
  composeFlag.current = false;
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

describe("UserTestingScenarioCreateFlow", () => {
  it("writes nothing until Save, then publishes in ONE call", async () => {
    const { onCreateScenario } = renderFlow();

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
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

  it("cannot be saved without an environment", () => {
    renderFlow();
    expect(screen.getByTestId("user-testing-create-save")).toBeDisabled();
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
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

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
        new Error("Publishing an environment chatbox requires project admin."),
      );
    renderFlow(onCreateScenario);

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Publishing an environment chatbox requires project admin.",
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

  it("offers the handoff, not a dead end, when the project has no environments", () => {
    environmentsState.value = [];
    renderFlow();

    expect(
      screen.getByTestId("user-testing-create-no-environments"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-create-new-environment"),
    ).toBeInTheDocument();
  });
});

/**
 * Compose mode: the scenario's environment can be built here instead of picked,
 * which is what makes "publish this same setup on another client" one click.
 */
describe("UserTestingScenarioCreateFlow — composing a setup", () => {
  beforeEach(() => {
    composeFlag.current = true;
  });

  it("resolves the composed client into a row, then publishes THAT", async () => {
    const { onCreateScenario } = renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));
    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Cursor checkout" },
    });

    fireEvent.click(screen.getByTestId("user-testing-create-save"));

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
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    // A scenario runs in exactly one environment — never two stacks.
    await waitFor(() => expect(ensureAdhocMock).toHaveBeenCalledTimes(1));
    expect(ensureAdhocMock).toHaveBeenCalledWith({
      projectId: "p1",
      stacks: [{ hostId: "host-2" }],
    });
  });

  it("leaves the name to the user — a composed setup has nothing to name it after", () => {
    renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));

    expect(screen.getByTestId("user-testing-create-name")).toHaveValue("");
    expect(screen.getByTestId("user-testing-create-save")).toBeDisabled();
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
    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));
    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Reuse me" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

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
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

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
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Never a named row behind the user's back, and never a half-made scenario.
    expect(onCreateScenario).not.toHaveBeenCalled();
    expect(toastError.mock.calls[0][0]).toMatch(/pick a saved environment/i);
    // Still retryable — the button is not left spinning.
    expect(screen.getByTestId("user-testing-create-save")).not.toBeDisabled();
  });
});
