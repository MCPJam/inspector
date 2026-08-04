/**
 * New swarm create flow: Describe → Confirm personas → Create & launch.
 *
 * The properties worth pinning are the ones that cost money or lose work:
 * nothing is written until Launch, every created journey carries the SAME
 * rubric ids, each journey is launched exactly once, and a partial failure
 * keeps what landed instead of unwinding it.
 *
 * `JourneyRubricEditor` is stubbed to a single button — driving the real
 * predicate editor would test `ChecksSection`, which has its own tests.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Predicate } from "@/shared/eval-matching";

const CRITERION: Predicate = {
  type: "toolCalledAtLeastOnce",
  toolName: "search",
};

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

const environments = [
  {
    environmentId: "env-1",
    projectId: "proj-1",
    name: "Prod-like",
    hostId: "host-1",
    revision: 1,
  },
];

let existingPersonas: Array<Record<string, unknown>> = [];
let personaJourneys: Array<Record<string, unknown>> = [];

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return existingPersonas;
      case "journeys:listJourneysByPersona":
        return personaJourneys;
      case "hosts:listHosts":
        return [];
      case "projectEnvironments:listEnvironments":
        return environments;
      case "serverInspections:getEnvironmentToolInventory":
        return {
          environmentName: "Prod-like",
          serverCount: 2,
          toolCount: 7,
          capturedAt: 1_700_000_000_000,
        };
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => {
    if (name === "personas:createPersona") return createPersonaMock;
    if (name === "journeys:createJourney") return createJourneyMock;
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

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
}));

const generateSwarmPersonaBatchMock = vi.fn();
const launchJourneyRunMock = vi.fn();

vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return {
    ...actual,
    launchJourneyRun: (...args: unknown[]) => launchJourneyRunMock(...args),
    generateSwarmPersonaBatch: (...args: unknown[]) =>
      generateSwarmPersonaBatchMock(...args),
  };
});

vi.mock("@/components/swarms/SwarmsSessionsPanel", () => ({
  SwarmsSessionsPanel: () => <div data-testid="sessions-panel" />,
}));

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));

vi.mock("@/lib/chatbox-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/swarms/journey-rubric-editor", () => ({
  JourneyRubricEditor: ({
    value,
    onChange,
  }: {
    value: Array<{ id: string; predicate: Predicate }>;
    onChange: (next: Array<{ id: string; predicate: Predicate }>) => void;
  }) => (
    <button
      type="button"
      onClick={() => onChange([{ id: "crit-1", predicate: CRITERION }])}
    >
      add criterion ({value.length})
    </button>
  ),
}));

vi.mock("@/components/mcpjam-agent/McpjamAgentComposer", () => ({
  McpjamAgentComposer: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label="Describe swarm"
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("@/components/project-environments/environment-picker", () => ({
  EnvironmentPicker: ({
    value,
    onChange,
    triggerTestId,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
    triggerTestId?: string;
  }) => (
    <button
      type="button"
      data-testid={triggerTestId ?? "environments-picker"}
      onClick={() => onChange(value.length ? [] : ["env-1"])}
    >
      {value.length ? `${value.length} env` : "pick env"}
    </button>
  ),
}));

const createPersonaMock = vi.fn();
const createJourneyMock = vi.fn();

import { SwarmsTab } from "../SwarmsTab";

function openDescribe() {
  render(<SwarmsTab projectId="proj-1" isAuthenticated />);
  fireEvent.click(screen.getByRole("button", { name: /^new swarm$/i }));
}

function submitLaunchEnabled() {
  return !(screen.getByTestId("new-swarm-launch") as HTMLButtonElement)
    .disabled;
}

function fillDescribe(text = "Support agents answering refunds") {
  fireEvent.change(screen.getByLabelText("Describe swarm"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
}

beforeEach(() => {
  vi.clearAllMocks();
  existingPersonas = [];
  personaJourneys = [];
  let personaSeq = 0;
  let journeySeq = 0;
  createPersonaMock.mockImplementation(async () => ({
    _id: `persona-${++personaSeq}`,
  }));
  createJourneyMock.mockImplementation(async () => ({
    _id: `journey-${++journeySeq}`,
  }));
  launchJourneyRunMock.mockImplementation(async () => ({
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
  }));
  generateSwarmPersonaBatchMock.mockResolvedValue({
    personas: [
      {
        persona: { name: "Refund Chaser", role: "Support agent", notes: "n1" },
        journeys: [{ name: "Refund a charge", goal: "Refund the charge" }],
      },
      {
        persona: { name: "Billing Dev", role: "Engineer wiring billing" },
        journeys: [{ goal: "Wire up the subscription webhook" }],
      },
    ],
  });
});

describe("SwarmsTab — New swarm create flow", () => {
  it("opens Describe from New swarm and Cancel returns to the tab", () => {
    openDescribe();

    expect(screen.getByTestId("new-swarm-create-flow")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: /who uses this server, and what do they try to do/i,
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("swarms-tab-header-chrome")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(
      screen.queryByTestId("new-swarm-create-flow")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("swarms-tab-header-chrome")).toBeInTheDocument();
  });

  it("keeps the action disabled until there is something to act on, and says why", () => {
    openDescribe();
    const submit = screen.getByTestId("new-swarm-continue");
    expect(submit).toBeDisabled();
    expect(screen.getByText(/describe your users to continue/i)).toBeVisible();

    // A description asks for a generation, which needs somewhere to ground on.
    fireEvent.change(screen.getByLabelText("Describe swarm"), {
      target: { value: "Support agents answering refunds" },
    });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(/pick an environment to generate against/i)
    ).toBeVisible();

    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    expect(submit).not.toBeDisabled();
    expect(submit).toHaveTextContent("Generate personas");
  });

  it("lets a returning user continue on personas alone — no description, no environment, no generation", async () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    openDescribe();

    const submit = screen.getByTestId("new-swarm-continue");
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(/describe your users, or pick a persona/i)
    ).toBeVisible();

    fireEvent.click(screen.getByRole("checkbox", { name: /include ana/i }));
    expect(submit).not.toBeDisabled();
    expect(submit).toHaveTextContent("Continue with 1 persona");

    fireEvent.click(submit);

    // Straight to Confirm with no model call and nothing to create.
    await screen.findByTestId("new-swarm-reused-personas");
    expect(generateSwarmPersonaBatchMock).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("new-swarm-proposed-personas")
    ).not.toBeInTheDocument();

    await waitFor(() => expect(submitLaunchEnabled()).toBe(true));
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    expect(createPersonaMock).not.toHaveBeenCalled();
    expect(createJourneyMock).not.toHaveBeenCalled();
    expect(launchJourneyRunMock.mock.calls[0][0].journeyId).toBe("j-existing");
  });

  it("names the combined result when both doors are used", () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByRole("checkbox", { name: /include ana/i }));

    expect(screen.getByTestId("new-swarm-continue")).toHaveTextContent(
      "Continue with 1 existing + 3 new"
    );
  });

  it("scales the session estimate with the number of environments", () => {
    openDescribe();
    const quick = screen.getByRole("radio", { name: /quick look/i });
    // 3 personas × 5 journeys × 1 session, before any environment is picked.
    expect(quick).toHaveTextContent("15 sessions");

    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    expect(quick).toHaveTextContent("15 sessions");
    expect(
      screen.getByRole("radio", { name: /launch gate/i })
    ).toHaveTextContent("120 sessions");
  });

  it("shows the grounding hint once an environment is picked", () => {
    openDescribe();
    expect(screen.queryByText(/grounded on/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    expect(
      screen.getByText(/grounded on 7 tools from prod-like/i)
    ).toBeVisible();
  });

  it("hides the existing-personas row when the project has none", () => {
    openDescribe();
    expect(
      screen.queryByTestId("new-swarm-existing-personas")
    ).not.toBeInTheDocument();
  });

  it("passes selected existing personas as dedup hints", async () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    openDescribe();
    fillDescribe();

    fireEvent.click(screen.getByRole("checkbox", { name: /include ana/i }));
    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    await waitFor(() =>
      expect(generateSwarmPersonaBatchMock).toHaveBeenCalled()
    );
    expect(generateSwarmPersonaBatchMock.mock.calls[0][0]).toMatchObject({
      projectId: "proj-1",
      environmentId: "env-1",
      personaCount: 3,
      journeyCount: 5,
      description: "Support agents answering refunds",
      existingPersonas: [{ name: "Ana", role: "Ops" }],
    });
  });

  it("writes nothing until Launch, then creates personas, journeys, and one run each", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    await screen.findByTestId("new-swarm-proposed-personas");
    // Generation alone must not touch the database.
    expect(createPersonaMock).not.toHaveBeenCalled();
    expect(createJourneyMock).not.toHaveBeenCalled();
    expect(screen.getByText("Refund Chaser")).toBeInTheDocument();
    expect(screen.getByText("Billing Dev")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(2));
    expect(createPersonaMock).toHaveBeenCalledTimes(2);
    expect(createPersonaMock.mock.calls[0][0]).toMatchObject({
      projectId: "proj-1",
      source: "generated",
      name: "Refund Chaser",
      role: "Support agent",
      notes: "n1",
    });
    expect(createJourneyMock).toHaveBeenCalledTimes(2);
    expect(createJourneyMock.mock.calls[0][0]).toMatchObject({
      projectId: "proj-1",
      personaRefId: "persona-1",
      name: "Refund a charge",
      goal: "Refund the charge",
      environmentIds: ["env-1"],
      config: { sessionsPerHost: 1, maxTurns: 6 },
    });
    // No grading authored ⇒ neither key is sent at all.
    expect(createJourneyMock.mock.calls[0][0]).not.toHaveProperty("rubric");
    expect(createJourneyMock.mock.calls[0][0]).not.toHaveProperty(
      "judgeConfig"
    );

    // Distinct idempotency keys — one run per journey, never a shared key.
    const keys = launchJourneyRunMock.mock.calls.map(
      (call) => call[0].launchKey
    );
    expect(new Set(keys).size).toBe(2);
    await screen.findByTestId("sessions-panel");
  });

  it("removing a persona on Confirm drops its journeys from the launch", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(
      screen.getByRole("button", { name: /remove persona billing dev/i })
    );
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    expect(createPersonaMock).toHaveBeenCalledTimes(1);
    expect(createJourneyMock).toHaveBeenCalledTimes(1);
  });

  it("stamps one rubric, with identical ids, onto every created journey", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getByTestId("new-swarm-grading-toggle"));
    fireEvent.click(screen.getByRole("button", { name: /add criterion/i }));
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(createJourneyMock).toHaveBeenCalledTimes(2));
    const rubrics = createJourneyMock.mock.calls.map((call) => call[0].rubric);
    // Shared ids are what let Findings roll a criterion up across the swarm.
    expect(rubrics[0]).toEqual([{ id: "crit-1", predicate: CRITERION }]);
    expect(rubrics[1]).toEqual(rubrics[0]);
  });

  it("keeps journeys that landed when one write fails, and reports the failure", async () => {
    createJourneyMock
      .mockRejectedValueOnce(new Error("Journey rejected"))
      .mockResolvedValueOnce({ _id: "journey-2" });
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    // The surviving journey still launches — a failed sibling doesn't unwind it.
    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    expect(createPersonaMock).toHaveBeenCalledTimes(2);
  });

  it("stays on Confirm with an explanation when no run launches", async () => {
    launchJourneyRunMock.mockRejectedValue(new Error("Out of credits"));
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no runs were launched/i
    );
    expect(screen.queryByTestId("sessions-panel")).not.toBeInTheDocument();
  });

  it("retrying after a launch failure re-launches without re-creating rows", async () => {
    launchJourneyRunMock.mockRejectedValue(new Error("Out of credits"));
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /2 journeys were created/i
    );
    expect(createJourneyMock).toHaveBeenCalledTimes(2);

    // The personas and journeys are real rows now. A retry that re-ran
    // creation would silently double every one of them.
    launchJourneyRunMock.mockResolvedValue({ runId: "run-1" });
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(4));
    expect(createPersonaMock).toHaveBeenCalledTimes(2);
    expect(createJourneyMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a generation failure inline and stays on Describe", async () => {
    generateSwarmPersonaBatchMock.mockRejectedValue(
      new Error("You're out of credits")
    );
    openDescribe();
    fillDescribe();

    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /out of credits/i
    );
    expect(
      screen.queryByTestId("new-swarm-proposed-personas")
    ).not.toBeInTheDocument();
  });

  it("launches a reused persona's existing journeys without rewriting them", async () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    generateSwarmPersonaBatchMock.mockResolvedValue({
      personas: [
        {
          persona: { name: "Refund Chaser", role: "Support agent" },
          journeys: [{ goal: "Refund the charge" }],
        },
      ],
    });
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByRole("checkbox", { name: /include ana/i }));
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    // Launch stays held until the reused persona's journeys have resolved —
    // launching early would silently omit them.
    await waitFor(() =>
      expect(screen.getByTestId("new-swarm-launch")).not.toBeDisabled()
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(2));
    // One new journey created; the reused one is launched by id, untouched.
    expect(createJourneyMock).toHaveBeenCalledTimes(1);
    const launched = launchJourneyRunMock.mock.calls.map(
      (call) => call[0].journeyId
    );
    expect(launched).toContain("j-existing");
  });

  it("holds Launch while a reused persona's journeys are still loading", async () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    // `undefined` is Convex's loading state — the card must not report an
    // empty target list for it.
    personaJourneys = undefined as never;
    generateSwarmPersonaBatchMock.mockResolvedValue({
      personas: [
        {
          persona: { name: "Refund Chaser", role: "Support agent" },
          journeys: [{ goal: "Refund the charge" }],
        },
      ],
    });
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByRole("checkbox", { name: /include ana/i }));
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");

    expect(screen.getByTestId("new-swarm-launch")).toBeDisabled();
  });
});
