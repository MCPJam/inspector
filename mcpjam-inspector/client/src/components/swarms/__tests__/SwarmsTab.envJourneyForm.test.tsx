/**
 * New-journey form (Project Environments): ordered env multi-select and the
 * create payload invariant — env submits send `environmentIds` + compat
 * `hostIds` recomputed from the selected environments (deduped, in order)
 * and OMIT `serverAttachmentId`.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

// The shared EnvironmentPicker reads project environments through
// `useProjectEnvironments`, which gates on the db-user-ready context (default
// false without a provider). Mark it ready so the picker subscribes.
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
    revision: 3,
  },
  {
    environmentId: "env-3",
    projectId: "proj-1",
    name: "Same host as Prod",
    hostId: "host-1",
    revision: 2,
  },
];

/** Mutable so a test can render a project that has NO environments yet. */
let environmentList: typeof environments = [];

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
        return environmentList;
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
  environmentList = environments;
  createJourneyMutation.mockResolvedValue({ _id: "journey-new" });
});

function openForm() {
  openPersonasTab();
  fireEvent.click(screen.getAllByText("Persona One")[0]);
  fireEvent.click(screen.getByRole("button", { name: /add goal/i }));
}

async function pickEnvironment(name: string | RegExp) {
  fireEvent.click(screen.getByTestId("journey-environments-picker"));
  fireEvent.click(await screen.findByRole("checkbox", { name }));
}

describe("SwarmsTab — new journey form env mode", () => {
  it("gates Create on ≥1 environment", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    openForm();

    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Draw a dog" },
    });
    const createBtn = screen.getByRole("button", { name: /create goal/i });
    expect(createBtn).toBeDisabled();

    await pickEnvironment(/prod-like/i);
    expect(createBtn).not.toBeDisabled();
  });

  it("env submit: environmentIds in selection order + compat hostIds deduped in order, NO serverAttachmentId", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    openForm();

    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Draw a dog" },
    });
    // Selection order: Staging-like (host-2), Prod-like (host-1),
    // Same host as Prod (host-1 again → deduped).
    fireEvent.click(screen.getByTestId("journey-environments-picker"));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /staging-like/i })
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /prod-like/i })
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /same host as prod/i })
    );

    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledTimes(1);
    });
    const payload = createJourneyMutation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.environmentIds).toEqual(["env-2", "env-1", "env-3"]);
    // Env-based journeys store NO host list — resolution reads the hosts
    // from the environments themselves.
    expect(payload.hostIds).toEqual([]);
    expect("serverAttachmentId" in payload).toBe(false);
  });

  it("shows the environments picker (no clients / server-group affordances)", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    openForm();

    expect(
      screen.getByTestId("journey-environments-picker")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /attached clients/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/no server group/i)
    ).not.toBeInTheDocument();
  });

  it("keeps Create disabled when the project has no environments", async () => {
    environmentList = [];
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    openForm();

    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Draw a dog" },
    });
    expect(
      screen.getByRole("button", { name: /create goal/i })
    ).toBeDisabled();
    expect(
      screen.getByTestId("journey-environments-picker")
    ).toBeInTheDocument();
  });
});
