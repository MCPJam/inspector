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
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const {
  environmentsState,
  flagState,
  saveSeedMock,
  toastSuccess,
  toastError,
  ensureAdhocMock,
} = vi.hoisted(() => ({
  environmentsState: {
    value: undefined as ProjectEnvironmentView[] | undefined,
  },
  flagState: { environments: true },
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
  useHostList: () => ({
    hosts: [
      { hostId: "host-1", name: "Claude" },
      { hostId: "host-2", name: "Cursor" },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => <div data-testid="server-group-picker" />,
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

import { UserTestingScenarioCreateFlow } from "@/components/scenarios/UserTestingScenarioCreateFlow";

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
  onSetPerTurnFeedback = vi.fn().mockResolvedValue(undefined),
) {
  render(
    <UserTestingScenarioCreateFlow
      projectId="p1"
      onCancel={vi.fn()}
      onCreateEnvironment={onCreateEnvironment}
      onCreateScenario={onCreateScenario}
      onSetPerTurnFeedback={onSetPerTurnFeedback}
    />,
  );
  return { onCreateScenario, onCreateEnvironment, onSetPerTurnFeedback };
}

beforeEach(() => {
  vi.clearAllMocks();
  sharePolicyState.policy = undefined;
  flagState.environments = true;
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
  beforeEach(() => {
    sharePolicyState.policy = undefined;
  });

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

  /**
   * The gate above is old; SAYING so is the fix. It was reported as "I can
   * create a scenario without an environment" precisely because the only sign
   * was an inert button — so the requirement is stated on the field, and drops
   * away once the field is satisfied rather than nagging under a valid form.
   */
  it("says the environment is required, and stops saying it once one is picked", () => {
    renderFlow();

    expect(
      screen.getByTestId("user-testing-create-environment-required"),
    ).toBeInTheDocument();
    // Marked on the label too — an asterisk is what a scanning user reads as
    // "required" before they try Save.
    expect(screen.getAllByText("(required)").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });

    expect(
      screen.queryByTestId("user-testing-create-environment-required"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("user-testing-create-save")).not.toBeDisabled();
  });

  it("waits for the environment list before claiming anything is missing", () => {
    // `undefined` is "we haven't looked yet" — the loading line is the honest
    // answer there, and asserting a missing field would contradict it.
    environmentsState.value = undefined;
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
        new Error("Publishing an environment scenario requires project admin."),
      );
    renderFlow(onCreateScenario);

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

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

  /**
   * The client is what a composed setup HAS to be named after. Leaving the
   * field empty was survivable while composing was the exotic path; it is the
   * only path a flag-off project has, and it met that project with a required
   * field nothing fills.
   */
  it("names the scenario after the picked client until the user types", () => {
    renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));
    expect(screen.getByTestId("user-testing-create-name")).toHaveValue("Claude");
    expect(screen.getByTestId("user-testing-create-save")).not.toBeDisabled();

    fireEvent.change(screen.getByTestId("user-testing-create-name"), {
      target: { value: "Round 2 with real users" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));
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

    // Named after the client, so Save is reachable without typing.
    expect(screen.getByTestId("user-testing-create-name")).toHaveValue("Cursor");
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

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
      screen.getByRole("heading", { name: /create a new study/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /publish one of your environments, hand them to users, then read what happened in their sessions/i
      )
    ).toBeVisible();
    const back = screen.getByTestId("user-testing-create-back");
    expect(back).toHaveTextContent("User Testing");
    // The chevron the Swarms create flow uses, not an arrow. Asserted because
    // the whole point of the glyph is that the two flows match.
    expect(back.querySelector("svg.lucide-chevron-left")).not.toBeNull();
    expect(screen.getByLabelText(/^study name/i)).toBeInTheDocument();
    expect(screen.getByTestId("user-testing-create-save")).toHaveTextContent(
      "Create study"
    );
  });

  it("names the target strip the same thing Swarm does, flag on or off", () => {
    // It used to read "Environment" flag-on and "Where it runs" flag-off, which
    // made one control two different things depending on a flag.
    renderFlow();
    expect(screen.getByText("Where it runs")).toBeVisible();

    flagState.environments = false;
    render(
      <UserTestingScenarioCreateFlow
        projectId="p1"
        onCancel={vi.fn()}
        onCreateEnvironment={vi.fn()}
        onCreateScenario={vi.fn()}
        onSetPerTurnFeedback={vi.fn()}
      />
    );
    expect(screen.getAllByText("Where it runs")).toHaveLength(2);
  });

  it("offers per-turn ratings on by default, with stars selected", () => {
    renderFlow();

    const toggle = screen.getByTestId("user-testing-create-ratings");
    expect(toggle).toBeChecked();
    expect(
      screen.getByText(/testers will be able to rate each response/i)
    ).toBeVisible();
    expect(
      screen.getByRole("radio", { name: "1-5 Star Ratings" })
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radio", { name: "Thumbs-Up/Down Ratings" })
    ).toHaveAttribute("aria-checked", "false");
  });

  it("hides the style choice while ratings are off", () => {
    // A widget style is a question about a widget nobody is being shown.
    renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-ratings"));
    expect(
      screen.queryByTestId("user-testing-create-rating-style")
    ).not.toBeInTheDocument();
  });

  it("applies the ratings choice to the study it just created", async () => {
    const { onSetPerTurnFeedback } = renderFlow();

    fireEvent.click(screen.getByRole("radio", { name: /thumbs/i }));
    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    await waitFor(() => {
      expect(onSetPerTurnFeedback).toHaveBeenCalledWith("cb-1", {
        enabled: true,
        style: "thumbs",
      });
    });
  });

  it("leaves an already-published study's ratings alone", async () => {
    // Publishing is idempotent per environment, so a collision opens someone
    // else's study — rewriting its rating widget from here would reconfigure it.
    const { onSetPerTurnFeedback } = renderFlow(
      vi.fn().mockResolvedValue({ scenarioId: "cb-existing", created: false })
    );

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
    });
    expect(onSetPerTurnFeedback).not.toHaveBeenCalled();
  });

  it("keeps the study when only the ratings write fails, and says which half", async () => {
    const { onSetPerTurnFeedback } = renderFlow(
      undefined,
      undefined,
      vi.fn().mockRejectedValue(new Error("nope"))
    );

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    await waitFor(() => {
      expect(onSetPerTurnFeedback).toHaveBeenCalled();
    });
    // The study exists, so this is not reported as a failed creation.
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/study created, but the per-turn ratings setting/i)
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
    const { onSetPerTurnFeedback } = renderFlow();

    fireEvent.click(screen.getByTestId("user-testing-create-ratings"));
    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    await waitFor(() => {
      expect(onSetPerTurnFeedback).toHaveBeenCalledWith("cb-1", {
        enabled: false,
        style: "stars",
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
      screen.getByText("Your organization limits sharing to project members."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("user-testing-create-access")).toHaveTextContent(
      "Project members",
    );

    await user.click(screen.getByTestId("user-testing-create-access"));
    expect(
      await screen.findByRole("menuitemradio", { name: "Anyone with the link" }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitemradio", { name: "Invited users only" }),
    ).toHaveAttribute("data-disabled");

    fireEvent.change(screen.getByTestId("user-testing-create-environment"), {
      target: { value: "env-1" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    await waitFor(() => {
      expect(onCreateScenario).toHaveBeenCalledWith({
        environmentId: "env-1",
        name: "Checkout flow",
        mode: "project_members",
      });
    });
  });
});
