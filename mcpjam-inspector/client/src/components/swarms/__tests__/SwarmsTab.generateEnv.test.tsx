/**
 * AI generation dialog (Project Environments): grounding on the FIRST selected
 * environment (sent as `environmentId` — the backend resolves its server
 * group, or the host's own picks when it has none), and the create payload
 * invariant — generated journeys land with `environmentIds` + compat
 * `hostIds` and OMIT `serverAttachmentId`, exactly like the manual
 * new-journey form.
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
  notes: "",
};
const host = {
  hostId: "host-1",
  name: "Host One",
  modelId: "openai/gpt-4o-mini",
  ownerScope: { type: "journeys" },
};
const hostTwo = {
  hostId: "host-2",
  name: "Host Two",
  modelId: "anthropic/claude-haiku-4.5",
  ownerScope: { type: "journeys" },
};

/** `Prod-like` carries a server group (it can ground); `Bare` does not. */
const environments = [
  {
    environmentId: "env-1",
    projectId: "proj-1",
    name: "Prod-like",
    hostId: "host-1",
    serverAttachmentId: "att-env-1",
    revision: 1,
  },
  {
    environmentId: "env-2",
    projectId: "proj-1",
    name: "Staging-like",
    hostId: "host-2",
    serverAttachmentId: "att-env-2",
    revision: 1,
  },
  {
    environmentId: "env-3",
    projectId: "proj-1",
    name: "Bare",
    hostId: "host-2",
    revision: 1,
  },
];

const {
  createPersonaMutation,
  createJourneyMutation,
  generatePersonaMock,
  toastMock,
} = vi.hoisted(() => ({
  createPersonaMutation: vi.fn(),
  createJourneyMutation: vi.fn(),
  generatePersonaMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

let personaList: Array<Record<string, unknown>> = [];

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return personaList;
      case "journeys:listJourneysByPersona":
        return [];
      case "hosts:listHosts":
        return [host, hostTwo];
      case "projectEnvironments:listEnvironments":
        return environments;
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => {
    if (name === "personas:createPersona") return createPersonaMutation;
    if (name === "journeys:createJourney") return createJourneyMutation;
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
  return {
    ...actual,
    launchJourneyRun: vi.fn(),
    generateSwarmPersona: (...args: unknown[]) => generatePersonaMock(...args),
    generateSwarmJourneys: vi.fn(),
  };
});

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));
vi.mock("@/lib/chatbox-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { SwarmsTab } from "../SwarmsTab";
import { openPersonasTab } from "./swarms-tab-test-helpers";

beforeEach(() => {
  vi.clearAllMocks();
  personaList = [persona];
  createPersonaMutation.mockImplementation(async (args: any) => {
    const row = { ...args, _id: "persona-new", personaId: "pnew" };
    personaList = [...personaList, row];
    return row;
  });
  createJourneyMutation.mockResolvedValue({ _id: "journey-new" });
});

function openGeneratePersona() {
  render(<SwarmsTab projectId="proj-1" isAuthenticated />);
  openPersonasTab();
  fireEvent.click(
    screen.getByRole("button", { name: /generate persona with ai/i })
  );
}

async function pickEnvironment(name: string | RegExp) {
  fireEvent.click(screen.getByTestId("generate-environments-picker"));
  fireEvent.click(await screen.findByRole("checkbox", { name }));
}

describe("GenerateSwarmDialog — env mode", () => {
  it("gates Generate on an environment selection", async () => {
    openGeneratePersona();

    expect(
      screen.getByTestId("generate-environments-picker")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /attached clients/i })
    ).not.toBeInTheDocument();

    const submit = screen.getByRole("button", { name: /generate persona/i });
    expect(submit).toBeDisabled();
    await pickEnvironment(/prod-like/i);
    expect(submit).not.toBeDisabled();
  });

  it("allows an environment with no server group — the backend resolves the host's own picks", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "r" },
      journeys: [{ goal: "g" }],
    });
    openGeneratePersona();
    await pickEnvironment(/bare/i);

    const submit = screen.getByRole("button", { name: /generate persona/i });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => {
      expect(generatePersonaMock).toHaveBeenCalledTimes(1);
    });
    expect(generatePersonaMock).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "env-3" })
    );
  });

  it("grounds on the FIRST selected environment and writes env-shaped journeys", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "Curious Newcomer", role: "hobbyist" },
      journeys: [{ goal: "goal one" }],
    });

    openGeneratePersona();
    // Selection order decides grounding: Staging-like first, then Prod-like.
    fireEvent.click(screen.getByTestId("generate-environments-picker"));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /staging-like/i })
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /prod-like/i })
    );

    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(generatePersonaMock).toHaveBeenCalledTimes(1);
    });
    expect(generatePersonaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        environmentId: "env-2",
      })
    );
    // Grounding is env-native now: no attachment id is derived client-side.
    expect(
      (generatePersonaMock.mock.calls[0]![0] as Record<string, unknown>)
        .serverAttachmentId
    ).toBeUndefined();

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledTimes(1);
    });
    const payload = createJourneyMutation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.environmentIds).toEqual(["env-2", "env-1"]);
    // Compat hostIds recomputed from those envs, deduped in selection order.
    expect(payload.hostIds).toEqual(["host-2", "host-1"]);
    // The grounding id grounds the PROMPT only — it must not be persisted on
    // an env-based journey (that is what makes the env the source of truth).
    expect("serverAttachmentId" in payload).toBe(false);
  });
});
