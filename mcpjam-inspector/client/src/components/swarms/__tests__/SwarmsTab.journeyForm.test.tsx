/**
 * New-journey form: requires ≥1 environment; writes env-shaped createJourney
 * payloads (`environmentIds` + compat `hostIds`, no `serverAttachmentId`).
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

const { createJourneyMutation } = vi.hoisted(() => ({
  createJourneyMutation: vi.fn(),
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
        return [host, hostTwo];
      case "projectEnvironments:listEnvironments":
        return environments;
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => {
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
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SwarmsTab } from "../SwarmsTab";
import { openPersonasTab } from "./swarms-tab-test-helpers";

beforeEach(() => {
  vi.clearAllMocks();
  createJourneyMutation.mockResolvedValue({ _id: "journey-new" });
});

async function pickEnvironment(name: string | RegExp) {
  fireEvent.click(screen.getByTestId("journey-environments-picker"));
  fireEvent.click(await screen.findByRole("checkbox", { name }));
}

describe("SwarmsTab — new journey form", () => {
  it("keeps Create disabled until an environment is picked", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);
    fireEvent.click(screen.getByRole("button", { name: /add goal/i }));

    const createBtn = screen.getByRole("button", { name: /create goal/i });
    expect(createBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Draw a dog" },
    });
    expect(createBtn).toBeDisabled();

    await pickEnvironment(/prod-like/i);
    expect(createBtn).not.toBeDisabled();
  });

  it("passes environmentIds into createJourney", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);
    fireEvent.click(screen.getByRole("button", { name: /add goal/i }));

    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Draw a dog" },
    });
    await pickEnvironment(/prod-like/i);
    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          personaRefId: "persona-1",
          goal: "Draw a dog",
          hostIds: [],
          environmentIds: ["env-1"],
          config: { sessionsPerTarget: 2, maxTurns: 6 },
        })
      );
    });
    expect(
      "serverAttachmentId" in (createJourneyMutation.mock.calls[0]![0] as object)
    ).toBe(false);
  });

  it("lets you toggle multiple environments without closing the picker", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);
    fireEvent.click(screen.getByRole("button", { name: /add goal/i }));

    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Draw a dog" },
    });

    fireEvent.click(screen.getByTestId("journey-environments-picker"));
    const one = await screen.findByRole("checkbox", { name: /prod-like/i });
    const two = await screen.findByRole("checkbox", { name: /staging-like/i });
    fireEvent.click(one);
    fireEvent.click(two);

    expect(one).toHaveAttribute("aria-checked", "true");
    expect(two).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));
    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentIds: ["env-1", "env-2"],
          hostIds: [],
        })
      );
    });
  });
});
