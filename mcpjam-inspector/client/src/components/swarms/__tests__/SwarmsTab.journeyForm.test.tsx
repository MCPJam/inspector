/**
 * New-goal form: the goal text is the only field. Where it runs and how hard
 * it pushes follow the same defaults the swarm create flow and Generate use.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

const persona = {
  _id: "persona-1",
  personaId: "p1",
  name: "Persona One",
  role: "tester",
  notes: "",
};
const host = {
  hostId: "host-1",
  name: "Host One",
  modelId: "openai/gpt-4o-mini",
  ownerScope: { type: "journeys" },
  serverCount: 2,
};
// Carries a server group, so the composed default (client, no group) does not
// match it — the resolver reuses an equivalent row when there is one.
const environments = [
  {
    environmentId: "env-1",
    projectId: "proj-1",
    name: "Prod-like",
    hostId: "host-1",
    serverAttachmentId: "att-env-1",
    revision: 1,
  },
];

/** The row the backend mints for the composed client + server group. */
const ADHOC = {
  environmentId: "env-adhoc-1",
  projectId: "proj-1",
  hostId: "host-1",
  origin: "adhoc" as const,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

const { createJourneyMutation, ensureAdhocMock, environmentsEnabled } =
  vi.hoisted(() => ({
    createJourneyMutation: vi.fn(),
    ensureAdhocMock: vi.fn(),
    environmentsEnabled: { value: false },
  }));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => environmentsEnabled.value,
  useProjectEnvironmentsEnabledState: () => environmentsEnabled.value,
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return [persona];
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
  return { ...actual, launchJourneyRun: vi.fn() };
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
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SwarmsTab } from "../SwarmsTab";
import { openPersonasTab } from "./swarms-tab-test-helpers";

beforeEach(() => {
  vi.clearAllMocks();
  environmentsEnabled.value = false;
  createJourneyMutation.mockResolvedValue({ _id: "journey-new" });
  ensureAdhocMock.mockResolvedValue([{ environment: ADHOC, created: true }]);
});

async function openGoalForm(): Promise<void> {
  render(<SwarmsTab projectId="proj-1" isAuthenticated />);
  openPersonasTab();
  fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
  await screen.findByLabelText("Goal");
}

async function createGoal(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Goal"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /create goal/i }));
}

describe("SwarmsTab — new goal form", () => {
  it("offers the goal text and nothing else", async () => {
    await openGoalForm();

    expect(screen.queryByTestId("journey-environments-picker")).toBeNull();
    expect(screen.queryByLabelText("Sessions")).toBeNull();
    expect(screen.queryByLabelText("Turns")).toBeNull();
    expect(screen.queryByRole("button", { name: /advanced/i })).toBeNull();
    expect(screen.queryByText(/add check/i)).toBeNull();
  });

  it("gates Create on the goal text alone", async () => {
    await openGoalForm();
    const create = screen.getByRole("button", { name: /create goal/i });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "buy a plan" },
    });
    expect(create).not.toBeDisabled();
  });

  it("runs the goal against the composed default", async () => {
    await openGoalForm();
    await createGoal("buy a plan");

    await waitFor(() => {
      expect(ensureAdhocMock).toHaveBeenCalledWith(
        expect.objectContaining({ stacks: [{ hostId: "host-1" }] })
      );
    });
    const payload = createJourneyMutation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.environmentIds).toEqual(["env-adhoc-1"]);
    // The environments are the source of truth for what runs.
    expect(payload.hostIds).toEqual([]);
    expect("serverAttachmentId" in payload).toBe(false);
  });

  it("stamps the same run config the generated goals get", async () => {
    await openGoalForm();
    await createGoal("buy a plan");

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledTimes(1);
    });
    expect(
      (createJourneyMutation.mock.calls[0]![0] as Record<string, unknown>).config
    ).toEqual({ sessionsPerTarget: 1, maxTurns: 6 });
  });

  it("leaves a new goal ungraded, to be scored from its card", async () => {
    await openGoalForm();
    await createGoal("buy a plan");

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledTimes(1);
    });
    const payload = createJourneyMutation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect("judgeConfig" in payload).toBe(false);
    expect("rubric" in payload).toBe(false);
  });

  it("prefers a saved environment when Environments is available", async () => {
    environmentsEnabled.value = true;
    await openGoalForm();
    await createGoal("buy a plan");

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledTimes(1);
    });
    expect(
      (createJourneyMutation.mock.calls[0]![0] as Record<string, unknown>)
        .environmentIds
    ).toEqual(["env-1"]);
    expect(ensureAdhocMock).not.toHaveBeenCalled();
  });
});
