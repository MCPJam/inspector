/**
 * UserTestingTab agent bridge handlers. Commands are dispatched through the
 * real command bus against a mounted UserTestingTab; the publish/delete
 * mutations, the environment list and the scenario list are mocked so the
 * handlers act through the SAME callbacks the buttons and dialogs use.
 *
 * Findings this pins:
 * - publish targets an ENVIRONMENT, carries name/access in the SAME mutation,
 *   and OPENS the scenario route (the surface has no in-page selection any
 *   more — the URL is the view state, so "select it" means navigate);
 * - re-publishing reports `created: false` and the EXISTING name/access rather
 *   than claiming it made something;
 * - publish refuses when Environments is off, instead of falling back to
 *   minting a client — the thing the scenario list stopped showing;
 * - resolution is EXACT: unknown and ambiguous both fail invalid_request
 *   without touching a mutation;
 * - delete addresses a SCENARIO, can only reach rows the list advertises, and
 *   leaves the environment behind it alone;
 * - a deleted scenario STAYS deleted (nothing re-provisions it);
 * - every command is refused when signed out;
 * - the snapshot reports redacted state and NEVER the share token / transcript
 *   text / visitor PII, and advertises the environments publish addresses.
 */
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import type { ScenarioListItem, ScenarioSettings } from "@/hooks/useScenarios";
import type { HostListItem } from "@/hooks/useClients";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import type {
  InspectorCommand,
  InspectorCommandError,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";

const SHARE_TOKEN = "SECRET-SHARE-TOKEN-do-not-leak";
const TRANSCRIPT = "TRANSCRIPT-CONTENTS-do-not-leak";
const VISITOR_PII = "Jane Visitor <jane@example.com>";

const hostClaude: HostListItem = {
  hostId: "host-1",
  name: "Claude",
  hostConfigId: "cfg-1",
  modelId: "anthropic/claude-haiku-4.5",
  serverCount: 1,
  ownerScope: null,
  createdAt: 0,
  updatedAt: 0,
};
const hostCursor: HostListItem = {
  hostId: "host-2",
  name: "Cursor",
  hostConfigId: "cfg-2",
  modelId: "anthropic/claude-sonnet-4.5",
  serverCount: 0,
  ownerScope: null,
  createdAt: 0,
  updatedAt: 0,
};
const hostJourney: HostListItem = {
  hostId: "host-3",
  name: "Journey bot",
  hostConfigId: "cfg-3",
  modelId: "anthropic/claude-haiku-4.5",
  serverCount: 0,
  ownerScope: { type: "journeys" },
  createdAt: 0,
  updatedAt: 0,
};
/** Same NAME as hostCursor — only the ambiguity case puts it in the list. */
const hostCursorTwin: HostListItem = {
  hostId: "host-4",
  name: "Cursor",
  hostConfigId: "cfg-4",
  modelId: "anthropic/claude-sonnet-4.5",
  serverCount: 0,
  ownerScope: null,
  createdAt: 0,
  updatedAt: 0,
};

/**
 * Mutable per test: the post-delete case drops a row to prove the surface
 * never re-provisions what an agent just deleted.
 */
let listRows: ScenarioListItem[] = [];

const scenarioList: ScenarioListItem[] = [
  {
    scenarioId: "cb-1",
    projectId: "proj-1",
    name: "Claude",
    hostStyle: "claude",
    mode: "anyone_with_link",
    allowGuestAccess: true,
    serverCount: 2,
    serverNames: ["Asana", "GitHub"],
    namedHostId: "host-1",
    namedHostName: "Claude",
    // A published scenario carries the secret token in its list row too, so
    // the redaction assertions below cover the LIST path, not just the detail.
    link: {
      token: SHARE_TOKEN,
      path: "/c/x",
      url: `https://app/c/${SHARE_TOKEN}`,
    },
    uniqueTesterCount: 3,
    lastSessionAt: 200,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    scenarioId: "cb-2",
    projectId: "proj-1",
    name: "Cursor",
    hostStyle: "chatgpt",
    mode: "anyone_with_link",
    allowGuestAccess: true,
    serverCount: 0,
    serverNames: [],
    namedHostId: "host-2",
    namedHostName: "Cursor",
    link: null,
    createdAt: 0,
    updatedAt: 0,
  },
];

const scenarioSettings: ScenarioSettings = {
  scenarioId: "cb-1",
  projectId: "proj-1",
  name: "Claude scenario",
  hostStyle: "claude",
  systemPrompt: "",
  modelId: "anthropic/claude-haiku-4.5",
  temperature: 0.7,
  requireToolApproval: false,
  allowGuestAccess: true,
  mode: "anyone_with_link",
  servers: [
    {
      serverId: "srv-1",
      serverName: "Asana",
      useOAuth: false,
      serverUrl: null,
      clientId: null,
      oauthScopes: null,
      optional: false,
    },
    {
      serverId: "srv-2",
      serverName: "GitHub",
      useOAuth: false,
      serverUrl: null,
      clientId: null,
      oauthScopes: null,
      optional: true,
    },
  ],
  namedHostId: "host-1",
  namedHostName: "Claude",
  link: {
    token: SHARE_TOKEN,
    path: "/c/x",
    url: `https://app/c/${SHARE_TOKEN}`,
    rotatedAt: 0,
    updatedAt: 0,
  },
  members: [],
};

const sessionThreads: SharedChatThread[] = [
  {
    _id: "thread-1",
    sourceType: "scenario",
    chatSessionId: "sess-1",
    scenarioId: "cb-1",
    startedAt: 100,
    lastActivityAt: 200,
    messageCount: 4,
    toolCallCount: 2,
    synthetic: true,
    authType: "guest",
    modelId: "anthropic/claude-haiku-4.5",
    firstMessagePreview: TRANSCRIPT,
    visitorDisplayName: VISITOR_PII,
    feedbackComment: TRANSCRIPT,
  },
];

const {
  publishEnvironmentScenarioMock,
  deleteScenarioMock,
  navigateMock,
  hostListState,
  scenarioState,
  usageState,
  environmentsState,
  flagState,
} = vi.hoisted(() => ({
  publishEnvironmentScenarioMock: vi.fn(),
  deleteScenarioMock: vi.fn(),
  navigateMock: vi.fn(),
  // Mutable so a case can vary the host list (ambiguity) or drop the scenario's
  // scenario mid-test (the post-delete rerender).
  hostListState: { hosts: [] as HostListItem[], isLoading: false },
  scenarioState: { scenario: null as ScenarioSettings | null, isLoading: false },
  usageState: {
    threads: undefined as SharedChatThread[] | undefined,
    breakdown: undefined,
    rebuild: vi.fn(),
  },
  environmentsState: { value: [] as any[] },
  flagState: { enabled: true },
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

// `useAppNavigate`, not react-router's `useNavigate`: app navigation goes
// through the scoped helper now, which carries the active project into
// project-owned paths (`/p/<projectId>/hosts/<id>`). The rest of
// `app-navigation` is the real module — these suites assert against its
// path builders.
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => navigateMock,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: () => vi.fn(),
}));

// The surface resolves `:scenarioId` out of the host LIST — there is no
// separate host query to seed.
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => hostListState,
  // The tab holds `createHost` for the create route; these suites never reach
  // it, but an absent export fails module resolution.
  useHostMutations: () => ({ createHost: vi.fn() }),
}));

vi.mock("@/hooks/useScenarios", () => ({
  useScenario: () => scenarioState,
  useScenarioList: () => ({ scenarios: listRows, isLoading: false }),
  useScenarioMutations: () => ({ deleteScenario: deleteScenarioMock }),
  useEnvironmentScenarioMutations: () => ({
    publishEnvironmentScenario: publishEnvironmentScenarioMock,
  }),
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => environmentsState.value,
}));

// The list filter itself is exercised in UserTestingTab.scenario-list.test.tsx;
// here it is ON so the fixtures the snapshot and the delete tool see are the
// SAME rows a user sees.
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => flagState.enabled,
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useUsageInsights: () => usageState,
}));

// Heavy children — stub so the surface mounts without their hook trees. The
// bridge (useSurfaceAgentBridge) registers before any of these render.
vi.mock("@/components/scenarios/UserTestingScenarioDetail", () => ({
  UserTestingScenarioDetail: () => <div data-testid="stub-scenario-detail" />,
}));
vi.mock("@/components/scenarios/UserTestingOverviewPanel", () => ({
  UserTestingOverviewPanel: () => <div data-testid="stub-overview-panel" />,
}));

import { UserTestingTab } from "@/components/UserTestingTab";

let commandSeq = 0;
async function dispatch(command: Omit<InspectorCommand, "id">) {
  commandSeq += 1;
  let response!: InspectorCommandResponse;
  await act(async () => {
    response = await executeInspectorCommand({
      ...command,
      id: `user-testing-bridge-${commandSeq}`,
    } as InspectorCommand);
  });
  return response;
}

function expectCommandError(
  response: InspectorCommandResponse
): InspectorCommandError {
  if (response.status !== "error") {
    throw new Error(
      `expected an error response, got ${JSON.stringify(response)}`
    );
  }
  return response.error;
}

function renderUserTesting(props?: {
  isAuthenticated?: boolean;
  projectId?: string | null;
  scenarioId?: string | null;
}) {
  return render(
    <UserTestingTab
      projectId={props?.projectId ?? "proj-1"}
      isAuthenticated={props?.isAuthenticated ?? true}
      scenarioId={props?.scenarioId ?? null}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hostListState.hosts = [hostClaude, hostCursor, hostJourney];
  hostListState.isLoading = false;
  listRows = scenarioList.map((row) => ({ ...row }));
  scenarioState.scenario = { ...scenarioSettings };
  scenarioState.isLoading = false;
  usageState.threads = sessionThreads;
  flagState.enabled = true;
  environmentsState.value = [
    { environmentId: "env-1", name: "Checkout flow", revision: 1 },
    { environmentId: "env-2", name: "Onboarding", revision: 1 },
    // Two environments legitimately share a name; only the ambiguity case
    // depends on it.
    { environmentId: "env-3", name: "Onboarding", revision: 1 },
  ];
  // Behaves like the real (idempotent) mutation: returns the row either way.
  publishEnvironmentScenarioMock.mockResolvedValue({
    scenarioId: "cb-env",
    environmentId: "env-1",
    name: "Checkout flow",
    mode: "invited_only",
    created: true,
    link: null,
    accessVersion: 1,
  });
  deleteScenarioMock.mockResolvedValue(undefined);
});

describe("UserTestingTab — agent bridge handlers", () => {
  it("publishScenario publishes an ENVIRONMENT and opens the scenario", async () => {
    renderUserTesting();
    const response = await dispatch({
      type: "publishScenario",
      payload: { environment: "Checkout flow", access: "link_guests" },
    });

    expect(response).toMatchObject({
      status: "success",
      result: {
        status: "scenario_published",
        scenarioId: "cb-env",
        environmentId: "env-1",
        created: true,
      },
    });
    // Access rides in the SAME mutation as the publish — never a follow-up
    // setScenarioMode, which would leave a window in the wrong mode.
    expect(publishEnvironmentScenarioMock).toHaveBeenCalledWith({
      environmentId: "env-1",
      mode: "anyone_with_link",
    });
    // Selection is the ROUTE, not in-page state: a publish that never
    // navigated leaves the agent reporting a scenario the user cannot see.
    expect(navigateMock).toHaveBeenCalledWith("/user-testing/cb-env");
  });

  it("publishScenario passes a name through, and reports an already-published environment honestly", async () => {
    publishEnvironmentScenarioMock.mockResolvedValue({
      scenarioId: "cb-env",
      environmentId: "env-1",
      name: "Round 1",
      mode: "invited_only",
      created: false,
      link: null,
      accessVersion: 1,
    });
    renderUserTesting();

    const response = await dispatch({
      type: "publishScenario",
      payload: { environment: "env-1", name: "Round 2" },
    });

    expect(publishEnvironmentScenarioMock).toHaveBeenCalledWith({
      environmentId: "env-1",
      name: "Round 2",
    });
    // Re-publishing keeps the EXISTING name and access (backend #887), so
    // claiming it was created — or renamed — would be a lie the model repeats.
    expect(response).toMatchObject({
      status: "success",
      result: { created: false, name: "Round 1", mode: "invited_only" },
    });
    expect((response as any).result.note).toMatch(/already published/i);
  });

  it("publishScenario refuses when Environments is off, rather than minting a client", async () => {
    flagState.enabled = false;
    renderUserTesting();

    const error = expectCommandError(
      await dispatch({
        type: "publishScenario",
        payload: { environment: "Checkout flow" },
      })
    );
    expect(error.code).toBe("unsupported_in_mode");
    expect(publishEnvironmentScenarioMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown target as invalid_request on both commands", async () => {
    renderUserTesting();
    const publishError = expectCommandError(
      await dispatch({ type: "publishScenario", payload: { environment: "Nope" } })
    );
    expect(publishError.code).toBe("invalid_request");
    const deleteError = expectCommandError(
      await dispatch({ type: "deleteScenario", payload: { scenario: "Nope" } })
    );
    expect(deleteError.code).toBe("invalid_request");
    expect(publishEnvironmentScenarioMock).not.toHaveBeenCalled();
    expect(deleteScenarioMock).not.toHaveBeenCalled();
  });

  it("rejects an AMBIGUOUS environment name and asks for the id instead of guessing", async () => {
    // Publishing the wrong environment hands testers the wrong setup, so
    // resolution refuses rather than picking one.
    renderUserTesting();
    const error = expectCommandError(
      await dispatch({ type: "publishScenario", payload: { environment: "Onboarding" } })
    );
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("id");
    expect(publishEnvironmentScenarioMock).not.toHaveBeenCalled();
  });

  it("deleteScenario addresses a SCENARIO by name and leaves its environment alone", async () => {
    listRows = [
      ...listRows,
      {
        ...scenarioList[0],
        scenarioId: "cb-env",
        name: "Checkout flow",
        namedHostId: "host-1",
        environmentId: "env-1",
        environmentName: "Checkout flow",
      },
    ];
    // Published from a saved environment: the backend keeps it, and says so.
    deleteScenarioMock.mockResolvedValue({
      deleted: true,
      retirement: { environmentArchived: false, hostDeleted: false },
    });
    renderUserTesting();

    const response = await dispatch({
      type: "deleteScenario",
      payload: { scenario: "Checkout flow" },
    });

    expect(deleteScenarioMock).toHaveBeenCalledWith({ scenarioId: "cb-env" });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "scenario_deleted", scenarioId: "cb-env", environmentId: "env-1" },
    });
    expect((response as any).result.note).toMatch(/environment.*unchanged/i);
  });

  // The copy is driven by the mutation's report, not a fixed sentence: a
  // scenario created by the User Testing flow retires its private setup and
  // client with it, and reporting "the environment is unchanged" there would
  // tell the user less damage was done than actually was.
  it("deleteScenario reports the retired backing when the scenario owned it", async () => {
    listRows = [
      ...listRows,
      {
        ...scenarioList[0],
        scenarioId: "cb-env",
        name: "Checkout flow",
        namedHostId: "host-1",
        environmentId: "env-1",
        environmentName: "Checkout flow",
      },
    ];
    deleteScenarioMock.mockResolvedValue({
      deleted: true,
      retirement: { environmentArchived: true, hostDeleted: true },
    });
    renderUserTesting();

    const response = await dispatch({
      type: "deleteScenario",
      payload: { scenario: "Checkout flow" },
    });

    expect((response as any).result.note).toMatch(
      /setup and the private client .* removed/i,
    );
    expect((response as any).result.note).not.toMatch(/unchanged/i);
  });

  // Partial retirement is a real outcome (a suite still references the client,
  // or it is the project's last one). Saying only "removed" would be wrong.
  it("deleteScenario reports a kept client with its reason", async () => {
    listRows = [
      ...listRows,
      {
        ...scenarioList[0],
        scenarioId: "cb-env",
        name: "Checkout flow",
        namedHostId: "host-1",
        environmentId: "env-1",
        environmentName: "Checkout flow",
      },
    ];
    deleteScenarioMock.mockResolvedValue({
      deleted: true,
      retirement: {
        environmentArchived: true,
        hostDeleted: false,
        keptReason: '2 eval suite reference(s) still point at it.',
      },
    });
    renderUserTesting();

    const response = await dispatch({
      type: "deleteScenario",
      payload: { scenario: "Checkout flow" },
    });

    expect((response as any).result.note).toMatch(/client behind it was kept/i);
    expect((response as any).result.note).toContain('eval suite');
  });

  it("deleteScenario can only reach rows the list actually advertises", async () => {
    // An auto-minted client row is filtered out of the list; addressing it by
    // name must not delete it behind the user's back.
    listRows = [
      {
        ...scenarioList[0],
        scenarioId: "cb-hidden",
        name: "Copilot",
        mode: "project_members",
        link: null,
        uniqueTesterCount: undefined,
        lastSessionAt: undefined,
      },
    ];
    renderUserTesting();

    const error = expectCommandError(
      await dispatch({ type: "deleteScenario", payload: { scenario: "Copilot" } })
    );
    expect(error.code).toBe("invalid_request");
    expect(deleteScenarioMock).not.toHaveBeenCalled();
  });

  it("keeps the OPEN scenario deleted — nothing re-provisions it", async () => {
    const { rerender } = renderUserTesting({ scenarioId: "cb-1" });
    const response = await dispatch({
      type: "deleteScenario",
      payload: { scenario: "Claude" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "scenario_deleted", scenarioId: "cb-1" },
    });

    // The reactive queries now report the row gone. This used to need a
    // suppression latch, because a back-mint effect read `scenario === null` as
    // drift and re-provisioned — contradicting scenario_deleted.
    listRows = listRows.filter((row) => row.scenarioId !== "cb-1");
    scenarioState.scenario = null;
    await act(async () => {
      rerender(
        <UserTestingTab projectId="proj-1" isAuthenticated scenarioId="cb-1" />
      );
    });
    expect(await screen.findByText(/Scenario not found/i)).toBeInTheDocument();
  });

  it("refuses every command as unsupported_in_mode when signed out", async () => {
    renderUserTesting({ isAuthenticated: false });
    const deleteError = expectCommandError(
      await dispatch({ type: "deleteScenario", payload: { scenario: "Claude" } })
    );
    expect(deleteError.code).toBe("unsupported_in_mode");
    const publishError = expectCommandError(
      await dispatch({
        type: "publishScenario",
        payload: { environment: "Checkout flow" },
      })
    );
    expect(publishError.code).toBe("unsupported_in_mode");
    expect(deleteScenarioMock).not.toHaveBeenCalled();
    expect(publishEnvironmentScenarioMock).not.toHaveBeenCalled();
  });

  it("snapshot reports redacted state and NEVER the token / transcript / PII", async () => {
    renderUserTesting({ scenarioId: "cb-1" });

    const snapshot = await readSurfaceSnapshot("scenarios");
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        activeView: "detail",
        detailTab: "insights",
        scenarioCount: 2,
        scenarios: [
          { scenarioId: "cb-1", hostId: "host-1", hasPublishLink: true },
          { scenarioId: "cb-2", hostId: "host-2", hasPublishLink: false },
        ],
        selectedHostId: "host-1",
        selectedHostName: "Claude",
        published: true,
        hasPublishLink: true,
        isStandaloneSwarmHost: false,
        sessionCount: 1,
        sessions: [
          {
            id: "thread-1",
            messageCount: 4,
            toolCallCount: 2,
            synthetic: true,
          },
        ],
      },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(SHARE_TOKEN);
    expect(serialized).not.toContain(TRANSCRIPT);
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("Jane Visitor");
  });

  it("snapshot advertises the environments ui_publish_scenario addresses", async () => {
    // Exact resolution refuses a name it can't match, so the tool's own input
    // has to be discoverable somewhere — this is that somewhere.
    listRows = [
      ...listRows,
      { ...scenarioList[0], scenarioId: "cb-env", environmentId: "env-1" },
    ];
    renderUserTesting();

    const snapshot = (await readSurfaceSnapshot("scenarios")) as any;
    expect(snapshot.data.environments).toEqual(
      expect.arrayContaining([
        { environmentId: "env-1", name: "Checkout flow", published: true },
        { environmentId: "env-2", name: "Onboarding", published: false },
      ])
    );
  });
});
