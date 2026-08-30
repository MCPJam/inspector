/**
 * AI generation dialogs: gating on environments, row creation through the
 * ordinary mutations, partial-journey-failure copy, and inline quota (429)
 * rendering.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

const persona = {
  _id: "persona-1",
  personaId: "p1",
  name: "Persona One",
  role: "tester",
  notes: "cares about speed",
};
const host = {
  hostId: "host-1",
  name: "Host One",
  modelId: "openai/gpt-4o-mini",
  ownerScope: { type: "journeys" },
};
const environments = [
  {
    environmentId: "env-1",
    projectId: "proj-1",
    name: "Prod-like",
    hostId: "host-1",
    revision: 1,
  },
  {
    environmentId: "env-2",
    projectId: "proj-1",
    name: "Staging-like",
    hostId: "host-2",
    revision: 1,
  },
];

/** Mutable so a created persona shows up in the list the sidebar renders —
 * that is how the test observes the new row being SELECTED, not just written. */
let personaList: Array<Record<string, unknown>> = [];

const {
  createPersonaMutation,
  createJourneyMutation,
  generatePersonaMock,
  ensureAdhocMock,
  environmentsEnabled,
  generateJourneysMock,
  toastMock,
} = vi.hoisted(() => ({
  createPersonaMutation: vi.fn(),
  createJourneyMutation: vi.fn(),
  generatePersonaMock: vi.fn(),
  ensureAdhocMock: vi.fn(),
  environmentsEnabled: { value: true },
  generateJourneysMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return personaList;
      case "journeys:listJourneysByPersona":
        return [];
      case "hosts:listHosts":
        return [host];
      case "projectEnvironments:listEnvironments":
        return environments;
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => {
    if (name === "personas:createPersona") return createPersonaMutation;
    if (name === "journeys:createJourney") return createJourneyMutation;
    if (name === "projectEnvironments:ensureAdhocEnvironments")
      return ensureAdhocMock;
    return vi.fn().mockResolvedValue(undefined);
  },
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => environmentsEnabled.value,
  useProjectEnvironmentsEnabledState: () => environmentsEnabled.value,
}));

// The button is the handle the mid-flight test needs to retarget the dialog.
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: ({
    onChange,
  }: {
    onChange: (id: string) => void;
  }) => (
    <button
      type="button"
      data-testid="generate-server-group-picker"
      onClick={() => onChange("att-other")}
    >
      server group
    </button>
  ),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
}));

vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return {
    ...actual,
    launchJourneyRun: vi.fn(),
    generateSwarmPersona: (...args: unknown[]) => generatePersonaMock(...args),
    generateSwarmJourneys: (...args: unknown[]) =>
      generateJourneysMock(...args),
  };
});

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));
vi.mock("@/lib/scenario-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/components/swarms/SwarmsSessionsPanel", () => ({
  SwarmsSessionsPanel: () => null,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { SwarmsTab } from "../SwarmsTab";
import { openPersonasTab } from "./swarms-tab-test-helpers";
import { GenerateSwarmDialog } from "../GenerateSwarmDialog";
import { SwarmGenerateError } from "@/lib/swarm-api";

beforeEach(() => {
  vi.clearAllMocks();
  personaList = [persona];
  createPersonaMutation.mockImplementation(async (args: any) => {
    const row = { ...args, _id: "persona-new", personaId: "pnew" };
    personaList = [...personaList, row];
    return row;
  });
  createJourneyMutation.mockResolvedValue({ _id: "journey-new" });
  environmentsEnabled.value = true;
  ensureAdhocMock.mockResolvedValue([
    {
      environment: {
        environmentId: "env-adhoc-1",
        projectId: "proj-1",
        hostId: "host-1",
        origin: "adhoc",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      created: true,
    },
  ]);
});

function openGeneratePersona() {
  render(<SwarmsTab projectId="proj-1" isAuthenticated />);
  openPersonasTab();
  fireEvent.click(
    screen.getByRole("button", { name: /generate persona with ai/i })
  );
}


describe("SwarmsTab — generate persona", () => {
  it("opens ready to submit", async () => {
    openGeneratePersona();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /generate persona/i })
      ).not.toBeDisabled();
    });
  });

  it("creates the persona as generated, then one journey per result", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "Curious Newcomer", role: "hobbyist", notes: "n" },
      journeys: [{ name: "J1", goal: "goal one" }, { goal: "goal two" }],
    });

    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(createPersonaMutation).toHaveBeenCalledTimes(1);
    });
    expect(createPersonaMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        source: "generated",
        name: "Curious Newcomer",
        role: "hobbyist",
        notes: "n",
      })
    );
    // Avatar indices must be in `createPersona`'s accepted range — the
    // mutation throws (not clamps) on out-of-range values.
    const personaArgs = createPersonaMutation.mock.calls[0]![0] as any;
    expect(personaArgs.avatarShape).toBeGreaterThanOrEqual(0);
    expect(personaArgs.avatarShape).toBeLessThanOrEqual(5);
    expect(personaArgs.avatarPalette).toBeGreaterThanOrEqual(0);
    expect(personaArgs.avatarPalette).toBeLessThanOrEqual(5);

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledTimes(2);
    });
    expect(createJourneyMutation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: "proj-1",
        personaRefId: "persona-new",
        name: "J1",
        goal: "goal one",
        hostIds: [],
        environmentIds: ["env-1"],
        config: { sessionsPerTarget: 1, maxTurns: 6 },
      })
    );
    // The unnamed journey must not send an empty `name`.
    const secondCall = createJourneyMutation.mock.calls[1]![0] as any;
    expect(secondCall.name).toBeUndefined();
    expect(secondCall.goal).toBe("goal two");

    // The generated persona must also be SELECTED — the detail header renders
    // the selected persona's name, so a regression dropping onPersonaCreated
    // would leave "Persona One" selected and fail here.
    await waitFor(() => {
      expect(screen.getAllByText("Curious Newcomer").length).toBeGreaterThan(1);
    });

    // Forwards the dialog's grounding + count to the backend.
    expect(generatePersonaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        environmentId: "env-1",
        journeyCount: 3,
      })
    );
  });

  it("keeps created rows and reports the shortfall when a journey fails", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "R" },
      journeys: [{ goal: "one" }, { goal: "two" }],
    });
    createJourneyMutation
      .mockResolvedValueOnce({ _id: "journey-1" })
      .mockRejectedValueOnce(new Error("nope"));

    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        "Created persona + 1 of 2 goals"
      );
    });
  });

  it("reports the mutation error when no journey survives, keeping the persona", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "R" },
      journeys: [{ goal: "one" }, { goal: "two" }],
    });
    createJourneyMutation.mockRejectedValue(
      new Error("Environment not found")
    );

    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    // No "0 of 2" success toast — the dialog stays open and says why.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Environment not found");
    expect(toastMock.success).not.toHaveBeenCalled();
    // The persona itself did land — it must still be written, not rolled back.
    expect(createPersonaMutation).toHaveBeenCalledTimes(1);

    // ...and generation must now be locked. Re-submitting would spend quota
    // and create a SECOND persona rather than retrying the journey writes.
    const submit = screen.getByRole("button", { name: /generate persona/i });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => {
      expect(createPersonaMutation).toHaveBeenCalledTimes(1);
    });
    expect(generatePersonaMock).toHaveBeenCalledTimes(1);
    // "Cancel" would misdescribe a dialog that already wrote a row, so the
    // footer action is relabelled. (Radix renders its own "Close" X, so assert
    // the absence of "Cancel" rather than the presence of "Close".)
    expect(
      screen.queryByRole("button", { name: /^cancel$/i })
    ).not.toBeInTheDocument();
  });

  it("treats an empty generated slate as a failure and writes nothing", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "R" },
      journeys: [],
    });

    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("returned no goals");
    // Rejected BEFORE the persona write, so no journey-less row is stranded.
    expect(createPersonaMutation).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("targets the environments selected at submit, not a mid-flight change", async () => {
    let releaseGenerate: (v: unknown) => void = () => {};
    generatePersonaMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseGenerate = resolve;
        })
    );

    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));
    await waitFor(() => {
      expect(generatePersonaMock).toHaveBeenCalledTimes(1);
    });

    // Retarget the dialog while the generation request is still in flight.
    fireEvent.click(screen.getByTestId("generate-server-group-picker"));

    releaseGenerate({
      persona: { name: "P", role: "R" },
      journeys: [{ goal: "goal one" }],
    });

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledTimes(1);
    });
    // The snapshot wins: without it this would be [] and the mutation would
    // fail after the quota was already spent.
    expect(
      (createJourneyMutation.mock.calls[0]![0] as any).environmentIds
    ).toEqual(["env-1"]);
    // Env-based: no derived host list is stored.
    expect((createJourneyMutation.mock.calls[0]![0] as any).hostIds).toEqual(
      []
    );
  });

  it("dispatches one billed generation even on a double-click", async () => {
    let release: (v: unknown) => void = () => {};
    generatePersonaMock.mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    );

    openGeneratePersona();

    const submit = screen.getByRole("button", { name: /generate persona/i });
    // Two clicks with no render in between: `pending` has not committed yet,
    // so only the synchronous ref latch can stop the second dispatch.
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(generatePersonaMock).toHaveBeenCalledTimes(1);
    });

    release({ persona: { name: "P", role: "R" }, journeys: [{ goal: "g" }] });
    await waitFor(() => {
      expect(createPersonaMutation).toHaveBeenCalledTimes(1);
    });
  });

  it("renders a quota 429 inline instead of closing the dialog", async () => {
    generatePersonaMock.mockRejectedValue(
      new SwarmGenerateError(429, "You've hit your usage limit for today.")
    );

    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You've hit your usage limit for today.");
    expect(createPersonaMutation).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /generate persona/i })
    ).toBeInTheDocument();
  });
});

describe("SwarmsTab — generate journeys", () => {
  it("generates against the selected persona and creates the rows", async () => {
    generateJourneysMock.mockResolvedValue({
      journeys: [{ name: "JA", goal: "goal a" }],
    });

    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    // SwarmsTab auto-selects the first persona, so the journeys panel (and its
    // Generate button) is already mounted.
    fireEvent.click(
      screen.getByRole("button", { name: /generate goals with ai/i })
    );

    fireEvent.click(screen.getByRole("button", { name: /generate goals/i }));

    await waitFor(() => {
      expect(generateJourneysMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          environmentId: "env-1",
          journeyCount: 3,
          persona: {
            name: "Persona One",
            role: "tester",
            notes: "cares about speed",
          },
        })
      );
    });

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          personaRefId: "persona-1",
          name: "JA",
          goal: "goal a",
          hostIds: [],
          environmentIds: ["env-1"],
        })
      );
    });
    // Generating journeys must never create a persona.
    expect(createPersonaMutation).not.toHaveBeenCalled();
  });

  it("surfaces the mutation error when every journey write fails", async () => {
    generateJourneysMock.mockResolvedValue({
      journeys: [{ goal: "goal a" }, { goal: "goal b" }],
    });
    createJourneyMutation.mockRejectedValue(new Error("Goal is required"));

    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    // SwarmsTab auto-selects the first persona, so the journeys panel (and its
    // Generate button) is already mounted.
    fireEvent.click(
      screen.getByRole("button", { name: /generate goals with ai/i })
    );

    fireEvent.click(screen.getByRole("button", { name: /generate goals/i }));

    // Nothing was saved after spending generation quota — say so inline and
    // keep the dialog open, rather than a "Created 0 of 2" success toast.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Goal is required");
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});

/**
 * Rendered directly (not through SwarmsTab) so `personaCount` is a prop this
 * test can change — the cap-rejection path needs a re-render with a different
 * count, which a dialog-internal state change can't produce.
 */
describe("GenerateSwarmDialog — latch release on early rejection", () => {
  const baseProps = {
    mode: "persona" as const,
    open: true,
    onOpenChange: vi.fn(),
    projectId: "proj-1",
    environments: environments as any,
    hosts: [host],
    onCreatePersona: vi.fn().mockResolvedValue("persona-new"),
    onCreateJourney: vi.fn().mockResolvedValue(undefined),
  };

  it("does not wedge the button when the persona cap rejects", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "R" },
      journeys: [{ goal: "g" }],
    });

    const { rerender } = render(
      <GenerateSwarmDialog {...baseProps} personaCount={200} />
    );
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already has 200 personas"
    );
    expect(generatePersonaMock).not.toHaveBeenCalled();

    // Cap clears (a persona was deleted elsewhere). If the rejection above had
    // left the in-flight latch set, this click would be silently swallowed.
    rerender(<GenerateSwarmDialog {...baseProps} personaCount={1} />);
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(generatePersonaMock).toHaveBeenCalledTimes(1);
    });
  });
});
