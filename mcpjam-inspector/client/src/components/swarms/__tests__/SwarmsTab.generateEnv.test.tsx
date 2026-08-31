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
  useProjectEnvironmentsEnabled: () => environmentsEnabled.value,
  useProjectEnvironmentsEnabledState: () => environmentsEnabled.value,
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
  ensureAdhocMock,
  environmentsEnabled,
  attachments,
  hostRows,
  navigateAppMock,
  envRows,
  authed,
  toastMock,
} = vi.hoisted(() => ({
  createPersonaMutation: vi.fn(),
  createJourneyMutation: vi.fn(),
  generatePersonaMock: vi.fn(),
  ensureAdhocMock: vi.fn(),
  environmentsEnabled: { value: false },
  attachments: {
    value: { serverAttachments: [] as unknown[], isLoading: false },
  },
  hostRows: { value: [] as unknown[] },
  navigateAppMock: vi.fn(),
  envRows: { value: undefined as unknown },
  authed: { value: true },
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
        return hostRows.value;
      case "projectEnvironments:listEnvironments":
        return envRows.value;
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
  useConvexAuth: () => ({ isAuthenticated: authed.value }),
}));

vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  navigateApp: navigateAppMock,
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => attachments.value,
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
vi.mock("@/lib/scenario-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/components/swarms/SwarmsSessionsPanel", () => ({
  SwarmsSessionsPanel: () => null,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { SwarmsTab } from "../SwarmsTab";
import { GenerateSwarmDialog } from "../GenerateSwarmDialog";
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

describe("GenerateSwarmDialog — composed target", () => {
  beforeEach(() => {
    environmentsEnabled.value = false;
    attachments.value = { serverAttachments: [], isLoading: false };
    hostRows.value = [host, hostTwo];
    envRows.value = environments;
    authed.value = true;
    ensureAdhocMock.mockResolvedValue([{ environment: ADHOC, created: true }]);
  });

  it("opens ready to submit, with nothing to pick first", async () => {
    openGeneratePersona();

    expect(
      screen.queryByTestId("generate-environments-picker")
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /generate persona/i })
      ).not.toBeDisabled();
    });
  });

  it("mints the environment from the client before spending a generation", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "r" },
      journeys: [{ goal: "g" }],
    });
    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(ensureAdhocMock).toHaveBeenCalledTimes(1);
    });
    expect(ensureAdhocMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        stacks: [{ hostId: "host-1" }],
      })
    );
    await waitFor(() => {
      expect(generatePersonaMock).toHaveBeenCalledTimes(1);
    });
    expect(generatePersonaMock).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "env-adhoc-1" })
    );
  });

  it("spends no generation when the setup cannot be resolved", async () => {
    ensureAdhocMock.mockRejectedValue(new Error("backend said no"));
    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/backend said no/i);
    });
    expect(generatePersonaMock).not.toHaveBeenCalled();
    expect(createPersonaMutation).not.toHaveBeenCalled();
  });

  it("writes env-shaped journeys against the minted environment", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "Curious Newcomer", role: "hobbyist" },
      journeys: [{ goal: "goal one" }],
    });
    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledTimes(1);
    });
    const payload = createJourneyMutation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.environmentIds).toEqual(["env-adhoc-1"]);
    // Env-based journeys store NO host list — the environments are the
    // source of truth for what each target runs on.
    expect(payload.hostIds).toEqual([]);
    expect("serverAttachmentId" in payload).toBe(false);
  });

  it("prefers a saved environment when Environments is available", async () => {
    environmentsEnabled.value = true;
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "r" },
      journeys: [{ goal: "g" }],
    });
    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(generatePersonaMock).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: "env-1" })
      );
    });
    expect(ensureAdhocMock).not.toHaveBeenCalled();
  });

  const GROUP = {
    _id: "att-1",
    name: "Prod servers",
    serverIds: ["srv-1"],
    resolvedServerNames: ["alpha"],
    createdAt: 1,
    updatedAt: 1,
  };

  it("preselects the project's server group", async () => {
    attachments.value = { serverAttachments: [GROUP], isLoading: false };
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "r" },
      journeys: [{ goal: "g" }],
    });
    openGeneratePersona();
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(ensureAdhocMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stacks: [{ hostId: "host-1", serverAttachmentId: "att-1" }],
        })
      );
    });
  });

  it("waits for the server groups instead of latching an empty default", async () => {
    // The query reports an empty list while it loads.
    attachments.value = { serverAttachments: [], isLoading: true };
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "r" },
      journeys: [{ goal: "g" }],
    });
    const props = {
      mode: "persona" as const,
      open: true,
      onOpenChange: vi.fn(),
      projectId: "proj-1",
      environments: [],
      hosts: [{ hostId: "host-1" }],
      personaCount: 0,
      onCreatePersona: vi.fn().mockResolvedValue("persona-new"),
      onCreateJourney: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(<GenerateSwarmDialog {...props} />);
    expect(
      screen.getByRole("button", { name: /generate persona/i })
    ).toBeDisabled();

    // The query settles.
    attachments.value = { serverAttachments: [GROUP], isLoading: false };
    rerender(<GenerateSwarmDialog {...props} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /generate persona/i })
      ).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));
    await waitFor(() => {
      expect(ensureAdhocMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stacks: [{ hostId: "host-1", serverAttachmentId: "att-1" }],
        })
      );
    });
  });

  it("blocks when the client has no servers to read tools from", async () => {
    // What the resolver rejects as ENV_NO_SERVERS, caught before the round-trip.
    hostRows.value = [{ ...host, serverCount: 0 }];
    openGeneratePersona();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /no servers assigned/i
      );
    });
    expect(
      screen.getByRole("button", { name: /generate persona/i })
    ).toBeDisabled();
  });

  it("stays out of the way when the client's server count is unknown", async () => {
    // An older backend omits serverCount. Unknown is not zero, so blocking on
    // it would wall off a setup that runs fine.
    hostRows.value = [{ ...host, serverCount: undefined }];
    openGeneratePersona();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /generate persona/i })
      ).not.toBeDisabled();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends the user to Servers, closing the dialog behind it", async () => {
    hostRows.value = [{ ...host, serverCount: 0 }];
    openGeneratePersona();

    fireEvent.click(await screen.findByRole("button", { name: "Servers tab" }));

    expect(navigateAppMock).toHaveBeenCalledWith("/servers");
    // Navigating out from under an open modal would leave the overlay behind.
    // Asserted on the link: the sidebar button also matches /generate persona/i.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Servers tab" })).toBeNull();
    });
  });

  const USED_GROUP = {
    _id: "att-used",
    name: "Used group",
    serverIds: ["srv-used"],
    resolvedServerNames: ["used-server"],
    createdAt: 1,
    updatedAt: 1,
  };
  const OTHER_GROUP = {
    _id: "att-other",
    name: "Other group",
    serverIds: ["srv-other"],
    resolvedServerNames: ["other-server"],
    createdAt: 1,
    updatedAt: 1,
  };

  it("waits for the usage history before latching a default group", async () => {
    // The environments query is undefined while it loads, and `lastUsedAt`
    // rides on those rows. Seeding first freezes the wrong group.
    envRows.value = undefined;
    attachments.value = {
      serverAttachments: [OTHER_GROUP, USED_GROUP],
      isLoading: false,
    };
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "r" },
      journeys: [{ goal: "g" }],
    });
    const props = {
      mode: "persona" as const,
      open: true,
      onOpenChange: vi.fn(),
      projectId: "proj-1",
      environments: [],
      hosts: [{ hostId: "host-1" }],
      personaCount: 0,
      onCreatePersona: vi.fn().mockResolvedValue("persona-new"),
      onCreateJourney: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(<GenerateSwarmDialog {...props} />);

    // Usage history lands: the second group is the one this project runs.
    envRows.value = [
      {
        environmentId: "env-adhoc-used",
        projectId: "proj-1",
        hostId: "host-1",
        serverAttachmentId: "att-used",
        lastUsedAt: 1788100000000,
        origin: "adhoc",
        revision: 1,
      },
    ];
    rerender(<GenerateSwarmDialog {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));
    await waitFor(() => {
      expect(ensureAdhocMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stacks: [{ hostId: "host-1", serverAttachmentId: "att-used" }],
        })
      );
    });
  });

  it("still seeds when the environments query never runs", async () => {
    // A skipped query reports `undefined` forever, not "still loading". Waiting
    // on it would leave the dialog permanently unsubmittable.
    authed.value = false;
    envRows.value = undefined;
    attachments.value = { serverAttachments: [], isLoading: false };
    openGeneratePersona();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /generate persona/i })
      ).not.toBeDisabled();
    });
  });
});
