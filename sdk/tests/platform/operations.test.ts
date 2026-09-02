import { describe, expect, it, vi } from "vitest";
import { DECISION_LABEL_VOCABULARIES } from "../../src/contract/index.js";
import {
  callServerToolOperation,
  closeTunnelOperation,
  createEvalSuiteOperation,
  createHostOperation,
  cancelEvalRunOperation,
  listEvalCheckReposOperation,
  connectEvalCheckRepoOperation,
  createTunnelOperation,
  diagnoseServerOperation,
  getScenarioOperation,
  runEvalCaseOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  getEvalRunStepsOperation,
  getPluginVersionOperation,
  getRegistryDirectoryServerOperation,
  getServerPromptOperation,
  installRegistryDirectoryServerOperation,
  installRegistryServerOperation,
  searchRegistryDirectoryOperation,
  listScenariosOperation,
  listChatSessionsOperation,
  searchSessionsOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listProjectPluginsOperation,
  listProjectServersOperation,
  listProjectsOperation,
  listServerPromptsOperation,
  listServerResourcesOperation,
  listServerToolsOperation,
  PlatformApiClient,
  PlatformApiError,
  ALL_OPERATIONS,
  publishScenarioOperation,
  readServerResourceOperation,
  runEvalSuiteOperation,
  setEvalSuiteEnvironmentsOperation,
  showServersOperation,
} from "../../src/platform/index.js";

const PROJECTS = [
  {
    id: "project-old",
    name: "Old",
    description: null,
    icon: null,
    organizationId: "org-a",
    visibility: null,
    createdAt: 1,
    updatedAt: 100,
  },
  {
    id: "project-new",
    name: "New",
    description: null,
    icon: null,
    organizationId: "org-a",
    visibility: null,
    createdAt: 2,
    updatedAt: 200,
  },
];

const SERVERS = [
  {
    id: "server-1",
    projectId: "project-new",
    name: "Docs",
    enabled: true,
    transportType: "stdio",
    url: null,
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
];

const HTTP_SERVERS = [
  {
    id: "server-http",
    projectId: "project-new",
    name: "Echo",
    enabled: true,
    transportType: "http",
    url: "https://echo.example.com/mcp",
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: "server-disabled",
    projectId: "project-new",
    name: "Retired",
    enabled: false,
    transportType: "http",
    url: "https://retired.example.com/mcp",
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
  ...SERVERS,
];

const SUITES = [
  {
    id: "suite-1",
    name: "Smoke",
    projectId: "project-new",
    createdAt: 1,
    updatedAt: 2,
    latestRun: null,
    totals: { passed: 0, failed: 0, runs: 0 },
    passRateTrend: [],
  },
  {
    id: "suite-2",
    name: "Conformance",
    projectId: "project-new",
    createdAt: 1,
    updatedAt: 2,
    latestRun: null,
    totals: { passed: 0, failed: 0, runs: 0 },
    passRateTrend: [],
  },
];

const RUN = {
  id: "run-1",
  suiteId: "suite-1",
  runNumber: 4,
  status: "completed",
  result: "passed",
  summary: { total: 3, passed: 3, failed: 0, passRate: 1 },
  source: "api",
  notes: null,
  createdAt: 10,
  completedAt: 20,
};

const ITERATIONS = [
  {
    id: "iter-1",
    testCaseId: "case-1",
    title: "echo works",
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    model: "anthropic/claude-haiku-4.5",
    provider: "anthropic",
    startedAt: 11,
    durationMs: 1200,
    tokensUsed: 321,
    usage: null,
    actualToolCalls: [],
    expectedToolCalls: [],
    error: null,
  },
];

const EVAL_CASES = [
  {
    id: "case-1",
    suiteId: "suite-1",
    title: "echo works",
    steps: [],
    expectedOutput: null,
    iterations: 1,
    isNegative: false,
  },
];

const STEPS = [
  { stepId: "s1", stepIndex: 0, kind: "prompt", status: "ok", reason: null },
  {
    stepId: "s2",
    stepIndex: 1,
    kind: "assert",
    status: "fail",
    reason: "clear-cart never called",
    evidence: { screenshotUrl: "https://blob/s2.png", source: "scripted" },
  },
];

const ENVIRONMENTS = [
  {
    id: "env-stg",
    projectId: "project-new",
    name: "Staging",
    hostId: "host-1",
    revision: 7,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
];

const PLUGINS = [
  {
    id: "plugin-1",
    projectId: "project-new",
    name: "linear-tools",
    displayName: "Linear Tools",
    enabled: true,
    activeVersionId: "pv-1",
    createdAt: 1,
    updatedAt: 2,
  },
];

const PLUGIN_VERSION = {
  id: "pv-1",
  pluginId: "plugin-1",
  declaredVersion: "1.2.0",
  bundleHash: "hash-abc",
  manifestHash: "hash-manifest",
  status: "ready",
  componentCounts: {
    skills: 1,
    servers: 1,
    apps: 0,
    assets: 0,
    unsupported: 0,
  },
  servers: [
    {
      componentId: "psc-1",
      componentKey: "server:linear",
      declaredName: "linear",
      placement: "remote",
      authenticationPolicy: "on_use",
      materializedServerId: "server-1",
    },
  ],
  skills: [
    {
      componentId: "pskc-1",
      componentKey: "skill:triage",
      declaredName: "triage",
      modelRef: "linear-tools/triage",
      materializedSkillId: "skill-1",
    },
  ],
  createdAt: 1,
  readyAt: 2,
};

const SCENARIOS = [
  {
    id: "box-1",
    projectId: "project-new",
    name: "Support",
    description: null,
    mode: "anyone_with_link",
    hostStyle: "claude",
    hostId: "host-1",
    hostName: "Support host",
    serverCount: 1,
    serverNames: ["Echo"],
    link: { path: "/c/abc", url: "https://app.example.com/c/abc" },
    createdAt: null,
    updatedAt: null,
  },
];

const SCENARIO_DETAIL = {
  ...SCENARIOS[0],
  modelId: "anthropic/claude-haiku-4.5",
  systemPrompt: "Be helpful.",
  temperature: 0.3,
  requireToolApproval: true,
  servers: [
    {
      id: "server-http",
      name: "Echo",
      url: "https://echo.example.com/mcp",
      useOAuth: false,
    },
  ],
};

const SESSIONS = [
  {
    id: "session-1",
    title: "Debugging echo",
    status: "active",
    projectId: "project-new",
    visibility: "private",
    lastActivityAt: 50,
    createdAt: 40,
  },
];

/** One unified-feed row, as `GET /projects/{p}/sessions` returns it. */
const SESSION_SUMMARIES = [
  {
    id: "k57abc",
    chatSessionId: "wire-uuid-1",
    projectId: "project-new",
    sourceType: "direct",
    origin: null,
    status: "active",
    synthetic: false,
    lockReason: null,
    title: "Refund flow",
    firstMessagePreview: "how do refunds work",
    visibility: "private",
    ownedByViewer: true,
    startedAt: 10,
    lastActivityAt: 50,
    modelId: "claude-opus-4-8",
    messageCount: 4,
    parentRef: null,
    link: {
      path: "/playground?conversation=wire-uuid-1&project=project-new",
      url: "https://app.mcpjam.com/playground?conversation=wire-uuid-1&project=project-new",
    },
  },
];

type FixtureOverrides = {
  servers?: unknown[];
  suites?: unknown[];
  /**
   * Replaces the sessions envelope wholesale, so a test can model an OLD
   * backend: one that ignored the unknown `scope` param, ran a title search,
   * and answered without the echo marker.
   */
  sessionsEnvelope?: Record<string, unknown>;
  /**
   * The suite DETAIL the run ops read to compute their targets. Default: a
   * suite with NOTHING attached, which is the bare-rerun shape most of these
   * tests are about. Override it to model an attached-environment or
   * attached-host suite.
   */
  suiteDetail?: Record<string, unknown>;
  /** Per-target failure injection for the grouped-launch endpoint, keyed by
   *  target id. A present entry makes that target's entry a failure. */
  groupTargetFailures?: Record<string, { code: string; message: string }>;
  /** Model an API deployment with no grouped-launch endpoint at all. */
  noRunGroupEndpoint?: boolean;
};

/** A suite with nothing attached — the shape a bare rerun expects. */
const BARE_SUITE_DETAIL: Record<string, unknown> = {
  id: "suite-1",
  name: "Smoke",
  description: null,
  projectId: "project-new",
  environment: { servers: [] },
  executionConfig: null,
  hosts: [],
  environmentIds: [],
  settings: {},
  schedule: {},
  createdAt: 1,
  updatedAt: 1,
};

function makeClient(overrides: FixtureOverrides = {}): {
  client: PlatformApiClient;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const servers = overrides.servers ?? SERVERS;
  const suites = overrides.suites ?? SUITES;
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const path = url.pathname;
    if (path === "/api/v1/projects") {
      return Response.json({ items: PROJECTS });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/servers$/.test(path)) {
      return Response.json({ items: servers });
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/eval-suites$/.test(path) &&
      init?.method === "POST"
    ) {
      const requestBody = JSON.parse(String(init?.body)) as {
        name?: string;
        serverIds?: string[];
      };
      return Response.json(
        {
          suiteId: "suite-created",
          name: requestBody.name ?? null,
          servers: (requestBody.serverIds ?? []).map((id) => ({ id })),
          caseUpsert: { committed: [{ name: "case-1" }], failed: [] },
        },
        { status: 201 }
      );
    }
    if (/^\/api\/v1\/projects\/[^/]+\/sessions$/.test(path)) {
      return Response.json(
        overrides.sessionsEnvelope ?? {
          items: SESSION_SUMMARIES,
          scope: url.searchParams.get("scope") ?? "titles",
          nextCursor: "cursor-2",
        }
      );
    }
    if (/^\/api\/v1\/projects\/[^/]+\/eval-suites$/.test(path)) {
      return Response.json({ items: suites });
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/eval-run-groups$/.test(path) &&
      init?.method === "POST"
    ) {
      if (overrides.noRunGroupEndpoint) {
        return Response.json(
          { code: "NOT_FOUND", message: "No route" },
          { status: 404 }
        );
      }
      const requestBody = JSON.parse(String(init?.body)) as {
        suiteId: string;
        targets: Array<{ environmentId?: string; namedHostId?: string }>;
      };
      let started = 0;
      let failed = 0;
      const entries = requestBody.targets.map((target, index) => {
        const id = target.environmentId ?? target.namedHostId ?? "";
        const failure = overrides.groupTargetFailures?.[id];
        if (failure) {
          failed += 1;
          return { target, status: "failed", error: failure };
        }
        started += 1;
        return {
          target,
          status: "started",
          runId: `run-group-${index + 1}`,
          runStatus: "running",
          servers: [{ id: "server-saved", name: "Saved" }],
          environment: target.environmentId
            ? { id: target.environmentId, name: "Staging", revision: 7 }
            : null,
          caseUpsert: { committed: [], failed: [] },
        };
      });
      const firstStarted = entries.find((entry) => entry.status === "started");
      return Response.json(
        {
          runGroupId: "group-1",
          suiteId: requestBody.suiteId,
          outcome:
            started === 0 ? "failed" : failed > 0 ? "partial" : "started",
          startedCount: started,
          failedCount: failed,
          targets: entries,
          ...(firstStarted
            ? {
                runId: (firstStarted as { runId: string }).runId,
                status: "running",
              }
            : {}),
        },
        { status: 202 }
      );
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/eval-suites\/[^/]+$/.test(path) &&
      (init?.method ?? "GET") === "GET"
    ) {
      return Response.json(overrides.suiteDetail ?? BARE_SUITE_DETAIL);
    }
    if (/^\/api\/v1\/projects\/[^/]+\/eval-suites\/[^/]+\/runs$/.test(path)) {
      return Response.json({ items: [RUN] });
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/eval-suites\/[^/]+\/cases$/.test(path) &&
      (init?.method ?? "GET") === "GET"
    ) {
      return Response.json({ items: EVAL_CASES });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/environments$/.test(path)) {
      return Response.json({ items: ENVIRONMENTS });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/plugins$/.test(path)) {
      return Response.json({ items: PLUGINS });
    }
    if (/^\/api\/v1\/plugin-versions\/[^/]+$/.test(path)) {
      return Response.json(PLUGIN_VERSION);
    }
    if (/^\/api\/v1\/projects\/[^/]+\/eval-runs$/.test(path)) {
      expect(init?.method).toBe("POST");
      const requestBody = JSON.parse(String(init?.body)) as {
        serverIds?: string[];
        caseIds?: string[];
        environmentId?: string;
      };
      return Response.json(
        {
          runId: requestBody.caseIds?.length ? "run-case" : "run-9",
          suiteId: "suite-1",
          status: "running",
          caseUpsert: { committed: [], failed: [] },
          // Mirrors the API: explicit serverIds echo back; an omitted set
          // resolves server-side to the suite's saved selection.
          servers: requestBody.serverIds
            ? requestBody.serverIds.map((id) => ({ id }))
            : [{ id: "server-saved", name: "Saved" }],
          // The API always echoes the environment triple, null for a legacy run.
          environment: requestBody.environmentId
            ? { id: requestBody.environmentId, name: "Staging", revision: 7 }
            : null,
        },
        { status: 202 }
      );
    }
    if (/^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+$/.test(path)) {
      return Response.json(RUN);
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations$/.test(path)
    ) {
      return Response.json({ items: ITERATIONS, nextCursor: "cursor-2" });
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations\/[^/]+\/trace$/.test(
        path
      )
    ) {
      return Response.json({ messages: [{ role: "user", content: "hi" }] });
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations\/[^/]+\/steps$/.test(
        path
      )
    ) {
      return Response.json({ items: STEPS });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/cancel$/.test(path)) {
      expect(init?.method).toBe("POST");
      return Response.json({
        ...RUN,
        status: "cancelled",
        result: "cancelled",
      });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/tunnels$/.test(path)) {
      expect(init?.method).toBe("POST");
      const requestBody = JSON.parse(String(init?.body)) as { name?: string };
      const existed = requestBody.name === "Docs";
      return Response.json(
        {
          serverId: "server-tunnel",
          name: requestBody.name,
          existed,
          ...(existed ? { previousTransportType: "stdio" } : {}),
          slug: "calm-otter",
          url: "https://calm-otter.tunnels.example.com/api/mcp/adapter-http/server-tunnel?k=secret",
          connectToken: "ct_abc",
          connectTokenExpiresAt: 1234,
          relayWsUrl: "wss://relay.example.com/agent",
          secretVersion: 3,
        },
        { status: 201 }
      );
    }
    if (/^\/api\/v1\/projects\/[^/]+\/tunnels\/[^/]+\/close$/.test(path)) {
      expect(init?.method).toBe("POST");
      const serverId = decodeURIComponent(path.split("/")[6] ?? "");
      return Response.json({ serverId, status: "closed" });
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/environments\/[^/]+\/scenario$/.test(path)
    ) {
      expect(init?.method).toBe("PUT");
      const environmentId = decodeURIComponent(path.split("/")[6] ?? "");
      const requestBody =
        init?.body === undefined
          ? {}
          : (JSON.parse(String(init.body)) as Record<string, unknown>);
      // `env-existing` is already published: the route ignores create-time
      // overrides and says so, exactly as the real API does.
      const created = environmentId !== "env-existing";
      const overridesSent = Object.keys(requestBody).length > 0;
      return Response.json(
        {
          id: "scenario-1",
          environmentId,
          name: created ? (requestBody.name as string) ?? "Checkout" : "Kept",
          mode: created
            ? (requestBody.mode as string) ?? "project_members"
            : "anyone_with_link",
          accessVersion: 1,
          link: "https://app.mcpjam.com/s/checkout?t=abc",
          created,
          ...(!created && overridesSent ? { overridesIgnored: true } : {}),
          requestBody,
        },
        { status: created ? 201 : 200 }
      );
    }
    if (/^\/api\/v1\/projects\/[^/]+\/scenarios$/.test(path)) {
      return Response.json({ items: SCENARIOS });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/scenarios\/[^/]+$/.test(path)) {
      return Response.json(SCENARIO_DETAIL);
    }
    if (path === "/api/v1/chat-sessions") {
      return Response.json({ items: SESSIONS });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/servers\/[^/]+\/doctor$/.test(path)) {
      expect(init?.method).toBe("POST");
      return Response.json({ status: "healthy", checks: [] });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/servers\/[^/]+\/tools$/.test(path)) {
      const requestBody = JSON.parse(String(init?.body)) as {
        cursor?: string;
      };
      return Response.json({
        items: [{ name: "echo", cursorSeen: requestBody.cursor ?? null }],
        // The `""` sentinel lets one test exercise an empty-string nextCursor
        // coming back off the MCP passthrough; every other cursor is unchanged.
        nextCursor: requestBody.cursor === "penultimate" ? "" : "tools-page-2",
      });
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/servers\/[^/]+\/tools\/call$/.test(path)
    ) {
      const requestBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return Response.json({
        content: [{ type: "text", text: "ok" }],
        requestBody,
      });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/servers\/[^/]+\/prompts$/.test(path)) {
      return Response.json({ items: [{ name: "summarize" }] });
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/servers\/[^/]+\/prompts\/get$/.test(path)
    ) {
      const requestBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return Response.json({ messages: [], requestBody });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/servers\/[^/]+\/resources$/.test(path)) {
      return Response.json({ items: [{ uri: "file:///a" }] });
    }
    if (
      /^\/api\/v1\/projects\/[^/]+\/servers\/[^/]+\/resources\/read$/.test(path)
    ) {
      const requestBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return Response.json({ contents: [], requestBody });
    }
    return Response.json(
      { code: "NOT_FOUND", message: `No route for ${path}` },
      { status: 404 }
    );
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, fragment: string): URL[] {
  return fetchMock.mock.calls
    .map(([target]) => new URL(String(target)))
    .filter((url) => url.pathname.includes(fragment));
}

describe("listProjectsOperation", () => {
  it("parses empty input and returns projects most recently updated first", async () => {
    const { client } = makeClient();
    const input = listProjectsOperation.inputSchema.parse({});

    const result = await listProjectsOperation.execute(input, { client });

    expect(result.items.map((project) => project.id)).toEqual([
      "project-new",
      "project-old",
    ]);
  });
});

describe("listProjectServersOperation", () => {
  it("resolves the project by name and returns servers with other projects", async () => {
    const { client, fetchMock } = makeClient();

    const result = await listProjectServersOperation.execute(
      { project: "new" },
      { client }
    );

    expect(result.project).toEqual({
      id: "project-new",
      name: "New",
      organizationId: "org-a",
    });
    expect(result.items).toEqual(SERVERS);
    expect(result.otherProjects).toEqual([{ id: "project-old", name: "Old" }]);
    expect(callsTo(fetchMock, "/servers")[0]?.pathname).toContain(
      "/projects/project-new/servers"
    );
  });

  it("throws an actionable PlatformApiError for unknown projects", async () => {
    const { client } = makeClient();

    const error = await listProjectServersOperation
      .execute({ project: "missing" }, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("NOT_FOUND");
    expect((error as PlatformApiError).message).toContain("Available projects");
  });
});

describe("GitHub Checks operations", () => {
  /**
   * A client whose only project belongs to NO organization — the personal-
   * project case. `PlatformProject.organizationId` is nullable, and GitHub
   * Checks is configured per organization, so this is the one branch in these
   * two operations that throws before any request.
   */
  function personalProjectClient(): {
    client: PlatformApiClient;
    fetchMock: ReturnType<typeof vi.fn>;
  } {
    const fetchMock = vi.fn(async (target: unknown) => {
      const path = new URL(String(target)).pathname;
      if (path === "/api/v1/projects") {
        return Response.json({
          items: [
            {
              id: "project-personal",
              name: "Personal",
              description: null,
              icon: null,
              organizationId: null,
              visibility: null,
              createdAt: 1,
              updatedAt: 100,
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const client = new PlatformApiClient({
      baseUrl: "https://api.example.com/api/v1",
      getAuth: () => "sk_test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    return { client, fetchMock };
  }

  it("refuses to list for a project with no organization", async () => {
    const { client, fetchMock } = personalProjectClient();

    const error = await listEvalCheckReposOperation
      .execute({}, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("VALIDATION_ERROR");
    // The reason, not just a refusal: GitHub Checks is per organization.
    expect((error as PlatformApiError).message).toContain("organization");
    // An empty organizationId would have built `/organizations//eval-check-repos`
    // and come back as a flat not-found. Nothing is sent at all.
    expect(callsTo(fetchMock, "/eval-check-repos")).toHaveLength(0);
  });

  it("refuses to connect for a project with no organization", async () => {
    const { client, fetchMock } = personalProjectClient();

    const error = await connectEvalCheckRepoOperation
      .execute(
        { suite: "s", repo: "acme/widgets", outagePolicy: "fail_open" },
        { client }
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("VALIDATION_ERROR");
    // It reaches a shared repository — the refusal must land before the write,
    // and before the suite lookup that would otherwise run first.
    expect(callsTo(fetchMock, "/eval-check-repos")).toHaveLength(0);
  });
});

describe("showServersOperation", () => {
  it("assembles a payload without doctor calls for skip-only projects", async () => {
    const { client, fetchMock } = makeClient();

    const payload = await showServersOperation.execute({}, { client });

    expect(payload.project.id).toBe("project-new");
    expect(payload.servers).toEqual([
      expect.objectContaining({ id: "server-1", status: "skipped" }),
    ]);
    expect(payload.summary.skipped).toBe(1);
    // stdio server short-circuits before any doctor POST.
    expect(callsTo(fetchMock, "/doctor")).toHaveLength(0);
  });
});

describe("listEvalSuitesOperation", () => {
  it("resolves the default project and returns suites with other projects", async () => {
    const { client, fetchMock } = makeClient();

    const result = await listEvalSuitesOperation.execute({}, { client });

    expect(result.project.id).toBe("project-new");
    expect(result.items).toEqual(SUITES);
    expect(result.otherProjects).toEqual([{ id: "project-old", name: "Old" }]);
    expect(callsTo(fetchMock, "/eval-suites")[0]?.pathname).toBe(
      "/api/v1/projects/project-new/eval-suites"
    );
  });
});

describe("listEvalSuiteRunsOperation", () => {
  it("resolves the suite by name and forwards the limit", async () => {
    const { client, fetchMock } = makeClient();

    const result = await listEvalSuiteRunsOperation.execute(
      { suite: "smoke", limit: 5 },
      { client }
    );

    expect(result.suite).toEqual({ id: "suite-1", name: "Smoke" });
    expect(result.items).toEqual([RUN]);
    const runsUrl = callsTo(fetchMock, "/eval-suites/suite-1/runs")[0];
    expect(runsUrl?.searchParams.get("limit")).toBe("5");
  });

  it("lists the available suites when the selector misses", async () => {
    const { client } = makeClient();

    const error = await listEvalSuiteRunsOperation
      .execute({ suite: "nope" }, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("NOT_FOUND");
    expect((error as PlatformApiError).message).toContain(
      "Smoke (id: suite-1)"
    );
  });
});

describe("runEvalSuiteOperation", () => {
  it("omits serverIds so the platform connects the suite's saved selection", async () => {
    const { client, fetchMock } = makeClient({ servers: HTTP_SERVERS });

    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke" },
      { client }
    );

    expect(result.runId).toBe("run-9");
    expect(result.status).toBe("running");
    expect(result.suite).toEqual({ id: "suite-1", name: "Smoke" });
    // The resolved set comes from the API response, not a client guess.
    expect(result.servers).toEqual([{ id: "server-saved", name: "Saved" }]);

    const createCall = fetchMock.mock.calls.find(([target]) =>
      String(target).endsWith("/eval-runs")
    );
    expect(JSON.parse(String((createCall?.[1] as RequestInit).body))).toEqual({
      suiteId: "suite-1",
    });
    // No project-server listing is needed when nothing is overridden.
    expect(callsTo(fetchMock, "/servers")).toHaveLength(0);
  });

  it("resolves explicit server selectors by name or id and deduplicates", async () => {
    const { client, fetchMock } = makeClient({ servers: HTTP_SERVERS });

    const result = await runEvalSuiteOperation.execute(
      { suite: "suite-1", servers: ["echo", "server-http", "Retired"] },
      { client }
    );

    expect(result.servers).toEqual([
      { id: "server-http", name: "Echo" },
      { id: "server-disabled", name: "Retired" },
    ]);
    const createCall = fetchMock.mock.calls.find(([target]) =>
      String(target).endsWith("/eval-runs")
    );
    expect(JSON.parse(String((createCall?.[1] as RequestInit).body))).toEqual({
      suiteId: "suite-1",
      serverIds: ["server-http", "server-disabled"],
    });
  });

  it("rejects explicitly selected stdio servers before creating the run", async () => {
    const { client, fetchMock } = makeClient({ servers: HTTP_SERVERS });

    const error = await runEvalSuiteOperation
      .execute({ suite: "Smoke", servers: ["Docs"] }, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toContain(
      'Server "Docs" can\'t run hosted evals'
    );
    expect((error as PlatformApiError).message).toContain("stdio");
    // The deterministic failure happens before any run is created.
    const createCalls = fetchMock.mock.calls.filter(([target]) =>
      String(target).endsWith("/eval-runs")
    );
    expect(createCalls).toHaveLength(0);
  });

  it("fails with the available servers when a selector misses", async () => {
    const { client } = makeClient({ servers: HTTP_SERVERS });

    const error = await runEvalSuiteOperation
      .execute({ suite: "Smoke", servers: ["ghost"] }, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toContain(
      'Server "ghost" was not found'
    );
    expect((error as PlatformApiError).message).toContain("Echo");
  });

  it("resolves an environment name and echoes the pinned triple", async () => {
    // ATTACHED, because the op now checks attachment client-side: a fan-out
    // issues one request per target, so an unattached one has to fail before
    // its siblings start spending rather than after.
    const { client, fetchMock } = makeClient({
      servers: HTTP_SERVERS,
      suiteDetail: { ...BARE_SUITE_DETAIL, environmentIds: ["env-stg"] },
    });

    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke", environment: "staging" },
      { client }
    );

    const createCall = fetchMock.mock.calls.find(([target]) =>
      String(target).endsWith("/eval-runs")
    );
    expect(JSON.parse(String((createCall?.[1] as RequestInit).body))).toEqual({
      suiteId: "suite-1",
      environmentId: "env-stg",
    });
    expect(result.environment).toEqual({
      id: "env-stg",
      name: "Staging",
      revision: 7,
    });
  });

  it("reports null attribution for a legacy run", async () => {
    const { client } = makeClient({ servers: HTTP_SERVERS });

    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke" },
      { client }
    );

    expect(result.environment).toBeNull();
  });

  it("rejects environment together with servers, before any request", async () => {
    const { client, fetchMock } = makeClient({ servers: HTTP_SERVERS });

    const error = await runEvalSuiteOperation
      .execute(
        { suite: "Smoke", environment: "Staging", servers: ["echo"] },
        {
          client,
        }
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("VALIDATION_ERROR");
    expect((error as PlatformApiError).message).toContain(
      "either environment or servers"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects ambiguous suite names with the candidate ids", async () => {
    const duplicate = SUITES.map((suite) => ({ ...suite, name: "Smoke" }));
    const { client } = makeClient({ suites: duplicate, servers: HTTP_SERVERS });

    const error = await runEvalSuiteOperation
      .execute({ suite: "smoke" }, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toContain("ambiguous");
    expect((error as PlatformApiError).message).toContain("suite-1");
    expect((error as PlatformApiError).message).toContain("suite-2");
  });
});

describe("runEvalCaseOperation", () => {
  it("runs one case as a persisted run, posting caseIds", async () => {
    const { client, fetchMock } = makeClient({ servers: HTTP_SERVERS });

    const result = await runEvalCaseOperation.execute(
      { project: "new", suite: "Smoke", case: "echo works" },
      { client }
    );

    expect(result.case).toEqual({ id: "case-1", title: "echo works" });
    expect(result.runId).toBe("run-case");
    const runCall = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).endsWith("/eval-runs") &&
        (call[1] as RequestInit | undefined)?.method === "POST"
    );
    const body = JSON.parse(String((runCall?.[1] as RequestInit).body)) as {
      suiteId: string;
      caseIds: string[];
    };
    expect(body.suiteId).toBe("suite-1");
    expect(body.caseIds).toEqual(["case-1"]);
  });

  it("sends the resolved environmentId alongside caseIds", async () => {
    const { client, fetchMock } = makeClient({ servers: HTTP_SERVERS });

    const result = await runEvalCaseOperation.execute(
      {
        project: "new",
        suite: "Smoke",
        case: "echo works",
        environment: "Staging",
      },
      { client }
    );

    const runCall = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).endsWith("/eval-runs") &&
        (call[1] as RequestInit | undefined)?.method === "POST"
    );
    expect(JSON.parse(String((runCall?.[1] as RequestInit).body))).toEqual({
      suiteId: "suite-1",
      caseIds: ["case-1"],
      environmentId: "env-stg",
    });
    expect(result.environment).toEqual({
      id: "env-stg",
      name: "Staging",
      revision: 7,
    });
  });

  it("requires a suite and a case", () => {
    expect(
      runEvalCaseOperation.inputSchema.safeParse({ suite: "Smoke" }).success
    ).toBe(false);
    expect(
      runEvalCaseOperation.inputSchema.safeParse({ case: "echo works" }).success
    ).toBe(false);
  });
});

describe("createEvalSuiteOperation", () => {
  it("authors a suite from cases, resolving project and servers", async () => {
    const { client, fetchMock } = makeClient({ servers: HTTP_SERVERS });

    const result = await createEvalSuiteOperation.execute(
      {
        project: "new",
        name: "Authored smoke",
        servers: ["echo"],
        model: "anthropic/claude-haiku-4.5",
        cases: [
          {
            title: "echo works",
            intent: "greeting",
            steps: [
              { id: "s1", kind: "prompt", prompt: "say hi" },
              {
                id: "s2",
                kind: "assert",
                assertion: {
                  type: "toolCalledWith",
                  toolName: "echo",
                  args: { args: {} },
                },
              },
            ],
          },
        ],
      },
      { client }
    );

    expect(result.suite).toEqual({
      id: "suite-created",
      name: "Authored smoke",
    });
    expect(result.servers).toEqual([{ id: "server-http", name: "Echo" }]);
    expect(result.caseUpsert.committed).toEqual([{ name: "case-1" }]);

    const createCall = fetchMock.mock.calls.find(
      ([target, init]) =>
        String(target).endsWith("/eval-suites") &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(createCall).toBeTruthy();
    const body = JSON.parse(String((createCall?.[1] as RequestInit).body));
    expect(body.name).toBe("Authored smoke");
    expect(body.serverIds).toEqual(["server-http"]);
    expect(body.serverNames).toEqual(["Echo"]);
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    expect(body.tests).toHaveLength(1);
    expect(body.tests[0]).toMatchObject({
      title: "echo works",
      intent: "greeting",
      steps: [
        { id: "s1", kind: "prompt", prompt: "say hi" },
        expect.objectContaining({ kind: "assert" }),
      ],
    });
  });

  it("rejects stdio servers before creating the suite", async () => {
    const { client, fetchMock } = makeClient({ servers: HTTP_SERVERS });

    const error = await createEvalSuiteOperation
      .execute(
        {
          name: "Smoke",
          servers: ["Docs"],
          model: "anthropic/claude-haiku-4.5",
          cases: [
            {
              title: "t",
              steps: [{ id: "s1", kind: "prompt", prompt: "q" }],
            },
          ],
        },
        { client }
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toContain("stdio");
    const createCalls = fetchMock.mock.calls.filter(
      ([target, init]) =>
        String(target).endsWith("/eval-suites") &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(createCalls).toHaveLength(0);
  });

  it("forwards advanced case fields instead of stripping them", () => {
    const parsed = createEvalSuiteOperation.inputSchema.parse({
      name: "s",
      model: "anthropic/claude-haiku-4.5",
      servers: ["echo"],
      cases: [
        {
          title: "t",
          steps: [{ id: "s1", kind: "prompt", prompt: "q" }],
          advancedConfig: { system: "be terse", temperature: 0.2 },
          matchOptions: { caseSensitive: false },
          predicates: { mode: "replace", list: [] },
        },
      ],
    }) as {
      cases: Array<Record<string, unknown>>;
    };
    const authored = parsed.cases[0]!;
    expect(authored.steps).toEqual([{ id: "s1", kind: "prompt", prompt: "q" }]);
    expect(authored.advancedConfig).toEqual({
      system: "be terse",
      temperature: 0.2,
    });
    expect(authored.matchOptions).toEqual({ caseSensitive: false });
    expect(authored.predicates).toEqual({ mode: "replace", list: [] });
  });

  it("caps cases at 100 and requires non-empty steps per case", () => {
    const base = {
      name: "s",
      model: "anthropic/claude-haiku-4.5",
      servers: ["echo"],
    };
    const promptStep = { id: "s1", kind: "prompt", prompt: "q" };
    // Over the cap is rejected before any network call.
    expect(
      createEvalSuiteOperation.inputSchema.safeParse({
        ...base,
        cases: Array.from({ length: 101 }, (_, i) => ({
          title: `t${i}`,
          steps: [promptStep],
        })),
      }).success
    ).toBe(false);
    // A case without any steps is rejected...
    expect(
      createEvalSuiteOperation.inputSchema.safeParse({
        ...base,
        cases: [{ title: "t" }],
      }).success
    ).toBe(false);
    // ...but a single deterministic toolCall step (render-check) is accepted.
    expect(
      createEvalSuiteOperation.inputSchema.safeParse({
        ...base,
        cases: [
          {
            title: "probe",
            steps: [
              {
                id: "s1",
                kind: "toolCall",
                serverName: "echo",
                toolName: "echo",
                arguments: {},
              },
            ],
          },
        ],
      }).success
    ).toBe(true);
  });

  it("rejects an unknown top-level key rather than stripping it", () => {
    const parsed = createEvalSuiteOperation.inputSchema.safeParse({
      name: "s",
      model: "anthropic/claude-haiku-4.5",
      servers: ["echo"],
      cases: [
        { title: "t", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] },
      ],
      hostz: [],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some((issue) => /hostz/.test(issue.message))
    ).toBe(true);
  });

  it("requires a name, at least one server, and at least one case", () => {
    expect(createEvalSuiteOperation.inputSchema.safeParse({}).success).toBe(
      false
    );
    expect(
      createEvalSuiteOperation.inputSchema.safeParse({
        name: "n",
        model: "m",
        servers: [],
        cases: [
          { title: "t", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] },
        ],
      }).success
    ).toBe(false);
    expect(
      createEvalSuiteOperation.inputSchema.safeParse({
        name: "n",
        model: "m",
        servers: ["s"],
        cases: [],
      }).success
    ).toBe(false);
  });
});

describe("eval run polling operations", () => {
  it("defines the chain vocabulary IN BAND, not by reference", () => {
    // An MCP client sees the tool description and nothing else. The stage
    // order, the three-way chain discriminant and the five states used to live
    // only in the hosted agent's promptNotes, so every other MCP surface — the
    // public worker included — handed a model ~36 bare enum members with no
    // definitions and no way to look them up mid-turn.
    const description = getEvalRunOperation.description;

    // The order is normative: `notReached` is derived from position.
    expect(description).toContain(
      "connection → discovery → selection → call → response → userValue"
    );
    // The discriminant, and which of the three carries rows.
    for (const status of ["verified", "unverified", "absent"]) {
      expect(description).toContain(`\`${status}\``);
    }
    // Every state, each said as its own fact.
    for (const state of DECISION_LABEL_VOCABULARIES.stageStates) {
      expect(description).toContain(`\`${state}\``);
    }
    // THE claim this whole vocabulary exists to protect.
    expect(description).toContain("A LOCATION, NOT A CAUSE");
    expect(description).toContain(
      "authorizes proposing a change to the server under test"
    );
    // The full 29-reason vocabulary does not belong in a tool description; it
    // belongs where an agent already fetches reference material. Named here so
    // the pointer cannot be dropped while the skill stays served.
    expect(description).toContain("user-value-chain-glossary");
    // And the phrase that would make a client render a spend warning on a
    // read-only operation (mcp/tests/platformTools.test.ts ties it to
    // `risk: "spend"`, which a read must never declare).
    expect(description).not.toContain("COSTS MONEY");
    expect(getEvalRunOperation.risk).toBeUndefined();
    expect(getEvalRunOperation.readOnly).toBe(true);
  });

  it("returns the run from the project the caller addressed", async () => {
    const { client, fetchMock } = makeClient();

    const result = await getEvalRunOperation.execute(
      { project: "old", runId: "run-1" },
      { client }
    );

    expect(result.project.id).toBe("project-old");
    expect(result.run).toEqual(RUN);
    // The poll goes to the addressed project, not the most recent one.
    expect(callsTo(fetchMock, "/eval-runs/run-1")[0]?.pathname).toBe(
      "/api/v1/projects/project-old/eval-runs/run-1"
    );
  });

  it("requires a non-blank project the run belongs to", () => {
    for (const operation of [
      getEvalRunOperation,
      listEvalRunIterationsOperation,
    ]) {
      expect(operation.inputSchema.safeParse({ runId: "run-1" }).success).toBe(
        false
      );
      // Whitespace-only must fail too — trimming it away would silently
      // reintroduce the default-project guess this schema exists to prevent.
      expect(
        operation.inputSchema.safeParse({ project: "  ", runId: "run-1" })
          .success
      ).toBe(false);
    }
    expect(
      getEvalIterationTraceOperation.inputSchema.safeParse({
        runId: "run-1",
        iterationId: "iter-1",
      }).success
    ).toBe(false);
  });

  it("forwards iteration pagination params and surfaces nextCursor", async () => {
    const { client, fetchMock } = makeClient();

    const result = await listEvalRunIterationsOperation.execute(
      { project: "new", runId: "run-1", cursor: "cursor-1", limit: 25 },
      { client }
    );

    expect(result.items).toEqual(ITERATIONS);
    expect(result.nextCursor).toBe("cursor-2");
    const iterationsUrl = callsTo(fetchMock, "/iterations")[0];
    expect(iterationsUrl?.searchParams.get("cursor")).toBe("cursor-1");
    expect(iterationsUrl?.searchParams.get("limit")).toBe("25");
  });

  it("wraps the iteration trace with its identifiers", async () => {
    const { client } = makeClient();

    const result = await getEvalIterationTraceOperation.execute(
      { project: "project-new", runId: "run-1", iterationId: "iter-1" },
      { client }
    );

    expect(result.runId).toBe("run-1");
    expect(result.iterationId).toBe("iter-1");
    expect(result.trace).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("returns per-authored-step results for an iteration", async () => {
    const { client, fetchMock } = makeClient();

    const result = await getEvalRunStepsOperation.execute(
      { project: "project-new", runId: "run-1", iterationId: "iter-1" },
      { client }
    );

    expect(result.runId).toBe("run-1");
    expect(result.iterationId).toBe("iter-1");
    expect(result.steps).toEqual(STEPS);
    expect(callsTo(fetchMock, "/steps")[0]?.pathname).toBe(
      "/api/v1/projects/project-new/eval-runs/run-1/iterations/iter-1/steps"
    );
  });

  it("requires project + runId + iterationId", () => {
    expect(
      getEvalRunStepsOperation.inputSchema.safeParse({
        runId: "run-1",
        iterationId: "iter-1",
      }).success
    ).toBe(false);
    expect(
      getEvalRunStepsOperation.inputSchema.safeParse({
        project: "p",
        runId: "run-1",
      }).success
    ).toBe(false);
  });

  it("cancels a run via POST and returns it cancelled", async () => {
    const { client, fetchMock } = makeClient();

    const result = await cancelEvalRunOperation.execute(
      { project: "project-new", runId: "run-1" },
      { client }
    );

    expect(result.run.status).toBe("cancelled");
    expect(result.run.result).toBe("cancelled");
    const cancelCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith("/eval-runs/run-1/cancel")
    );
    expect((cancelCall?.[1] as RequestInit | undefined)?.method).toBe("POST");
  });
});

describe("scenario operations", () => {
  it("lists the project's scenarios", async () => {
    const { client } = makeClient();

    const result = await listScenariosOperation.execute({}, { client });

    expect(result.project.id).toBe("project-new");
    expect(result.items).toEqual(SCENARIOS);
  });

  it("resolves a scenario by name and fetches its detail", async () => {
    const { client, fetchMock } = makeClient();

    const result = await getScenarioOperation.execute(
      { scenario: "support" },
      { client }
    );

    expect(result.scenario).toEqual(SCENARIO_DETAIL);
    expect(callsTo(fetchMock, "/scenarios/box-1")[0]?.pathname).toBe(
      "/api/v1/projects/project-new/scenarios/box-1"
    );
  });

  it("lists the available scenarios when the selector misses", async () => {
    const { client } = makeClient();

    const error = await getScenarioOperation
      .execute({ scenario: "missing" }, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toContain(
      "Support (id: box-1)"
    );
  });
});

describe("publishScenarioOperation", () => {
  it("forwards the create-time overrides verbatim in the PUT body", async () => {
    const { client, fetchMock } = makeClient();

    const result = await publishScenarioOperation.execute(
      publishScenarioOperation.inputSchema.parse({
        environment: "env-1",
        name: "Checkout flow",
        description: "Guided checkout walkthrough",
        mode: "invited_only",
      }),
      { client }
    );

    const [request] = fetchMock.mock.calls.filter(([target]) =>
      String(target).includes("/scenario")
    );
    expect(new URL(String(request?.[0])).pathname).toBe(
      "/api/v1/projects/project-new/environments/env-1/scenario"
    );
    expect(JSON.parse(String((request?.[1] as RequestInit).body))).toEqual({
      name: "Checkout flow",
      description: "Guided checkout walkthrough",
      mode: "invited_only",
    });
    expect(result.scenario.created).toBe(true);
    expect(result.scenario.mode).toBe("invited_only");
    expect(result.overridesIgnored).toBeUndefined();
  });

  it("sends no body at all when there are no overrides", async () => {
    // The pre-override wire shape, preserved: a bodyless PUT is the common
    // case and what existing callers already produce.
    const { client, fetchMock } = makeClient();

    await publishScenarioOperation.execute(
      publishScenarioOperation.inputSchema.parse({ environment: "env-1" }),
      { client }
    );

    const [request] = fetchMock.mock.calls.filter(([target]) =>
      String(target).includes("/scenario")
    );
    expect((request?.[1] as RequestInit).body).toBeUndefined();
  });

  it("hoists overridesIgnored when a republish discarded the overrides", async () => {
    const { client } = makeClient();

    const result = await publishScenarioOperation.execute(
      publishScenarioOperation.inputSchema.parse({
        environment: "env-existing",
        mode: "invited_only",
      }),
      { client }
    );

    // The response's mode is the real one — the caller asked for
    // `invited_only` and must learn the link is NOT restricted.
    expect(result.scenario.created).toBe(false);
    expect(result.scenario.mode).toBe("anyone_with_link");
    expect(result.overridesIgnored).toBe(true);
  });

  it("rejects a mode outside the enum before any request", async () => {
    const { fetchMock } = makeClient();

    expect(
      publishScenarioOperation.inputSchema.safeParse({
        environment: "env-1",
        mode: "everyone",
      }).success
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("plugin operations", () => {
  it("lists the project's live plugins with the project resolved by selector", async () => {
    const { client } = makeClient();

    const result = await listProjectPluginsOperation.execute(
      { project: "new" },
      { client }
    );

    expect(result.project.id).toBe("project-new");
    expect(result.items).toEqual(PLUGINS);
  });

  it("fetches a plugin version by raw id, no project resolution round-trip", async () => {
    const { client, fetchMock } = makeClient();

    const result = await getPluginVersionOperation.execute(
      { pluginVersionId: "pv-1" },
      { client }
    );

    expect(result).toEqual(PLUGIN_VERSION);
    const paths = fetchMock.mock.calls.map(
      (call) => new URL(String(call[0])).pathname
    );
    expect(paths).toEqual(["/api/v1/plugin-versions/pv-1"]);
  });
});

describe("listChatSessionsOperation", () => {
  it("lists sessions unfiltered when no project is given", async () => {
    const { client, fetchMock } = makeClient();

    const result = await listChatSessionsOperation.execute({}, { client });

    expect(result.items).toEqual(SESSIONS);
    expect(result.project).toBeUndefined();
    const sessionsUrl = callsTo(fetchMock, "/chat-sessions")[0];
    expect(sessionsUrl?.searchParams.has("projectId")).toBe(false);
  });

  it("treats a blank project filter as unfiltered instead of the default project", async () => {
    const { client, fetchMock } = makeClient();

    // The schema rejects blank selectors outright…
    expect(
      listChatSessionsOperation.inputSchema.safeParse({ project: "   " })
        .success
    ).toBe(false);

    // …and raw execute() callers who bypass it still get the unfiltered
    // listing rather than a silent most-recent-project filter.
    const result = await listChatSessionsOperation.execute(
      { project: "   " },
      { client }
    );

    expect(result.project).toBeUndefined();
    const sessionsUrl = callsTo(fetchMock, "/chat-sessions")[0];
    expect(sessionsUrl?.searchParams.has("projectId")).toBe(false);
  });

  it("resolves the project filter and maps cursor onto the wire", async () => {
    const { client, fetchMock } = makeClient();

    const result = await listChatSessionsOperation.execute(
      { project: "new", status: "active", limit: 10, cursor: "abc" },
      { client }
    );

    expect(result.project?.id).toBe("project-new");
    const sessionsUrl = callsTo(fetchMock, "/chat-sessions")[0];
    expect(sessionsUrl?.searchParams.get("projectId")).toBe("project-new");
    expect(sessionsUrl?.searchParams.get("status")).toBe("active");
    expect(sessionsUrl?.searchParams.get("limit")).toBe("10");
    expect(sessionsUrl?.searchParams.get("before")).toBe("abc");
  });
});

describe("createTunnelOperation", () => {
  it("resolves the default project and returns the grant verbatim", async () => {
    const { client } = makeClient();

    const result = await createTunnelOperation.execute(
      { name: "My Tunnel" },
      { client }
    );

    expect(result.project.id).toBe("project-new");
    expect(result.grant.serverId).toBe("server-tunnel");
    expect(result.grant.slug).toBe("calm-otter");
    expect(result.grant.url).toContain("?k=");
    expect(result.grant.connectToken).toBe("ct_abc");
    expect(result.grant.relayWsUrl).toBe("wss://relay.example.com/agent");
    expect(result.grant.existed).toBe(false);
    expect(result.grant.previousTransportType).toBeUndefined();
  });

  it("passes existed/previous* through for name collisions", async () => {
    const { client } = makeClient();

    const result = await createTunnelOperation.execute(
      { project: "old", name: "Docs" },
      { client }
    );

    expect(result.project.id).toBe("project-old");
    expect(result.grant.existed).toBe(true);
    expect(result.grant.previousTransportType).toBe("stdio");
  });

  it("fails with the project resolution error for unknown projects", async () => {
    const { client } = makeClient();

    const error = await createTunnelOperation
      .execute({ project: "Nope", name: "x" }, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect(String((error as Error).message)).toContain("Nope");
  });

  it("is a non-read operation, like close", () => {
    expect(createTunnelOperation.readOnly).toBe(false);
    expect(closeTunnelOperation.readOnly).toBe(false);
  });
});

describe("closeTunnelOperation", () => {
  it("revokes by resolved project and server id", async () => {
    const { client, fetchMock } = makeClient();

    const result = await closeTunnelOperation.execute(
      { project: "new", serverId: "server-tunnel" },
      { client }
    );

    expect(result.project.id).toBe("project-new");
    expect(result.serverId).toBe("server-tunnel");
    expect(result.status).toBe("closed");
    const closeCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/tunnels/")
    );
    expect(String(closeCall?.[0])).toContain(
      "/projects/project-new/tunnels/server-tunnel/close"
    );
  });
});

describe("searchSessionsOperation", () => {
  it("puts the query, scope, and CSV sourceTypes on the wire", async () => {
    const { client, fetchMock } = makeClient();

    const result = await searchSessionsOperation.execute(
      {
        query: "refund",
        scope: "transcripts",
        project: "new",
        sourceTypes: ["direct", "eval"],
        status: "archived",
        limit: 25,
        cursor: "cursor-1",
      },
      { client }
    );

    const url = callsTo(fetchMock, "/sessions")[0];
    expect(url?.pathname).toBe("/api/v1/projects/project-new/sessions");
    expect(url?.searchParams.get("q")).toBe("refund");
    expect(url?.searchParams.get("scope")).toBe("transcripts");
    // ONE comma-joined param, not repeated keys — that is what the endpoint
    // parses.
    expect(url?.searchParams.get("sourceType")).toBe("direct,eval");
    expect(url?.searchParams.get("status")).toBe("archived");
    expect(url?.searchParams.get("limit")).toBe("25");
    // The cursor passes through unrenamed; it is opaque.
    expect(url?.searchParams.get("cursor")).toBe("cursor-1");

    expect(result.project.id).toBe("project-new");
    expect(result.scope).toBe("transcripts");
    expect(result.items).toEqual(SESSION_SUMMARIES);
    expect(result.nextCursor).toBe("cursor-2");
  });

  it("defaults to the titles scope and sends no sourceType filter", async () => {
    const { client, fetchMock } = makeClient();

    const result = await searchSessionsOperation.execute(
      { query: "refund" },
      { client }
    );

    const url = callsTo(fetchMock, "/sessions")[0];
    expect(url?.searchParams.get("scope")).toBe("titles");
    expect(url?.searchParams.has("sourceType")).toBe(false);
    expect(result.scope).toBe("titles");
  });

  it("requires a query — this operation searches, it does not list", async () => {
    expect(searchSessionsOperation.inputSchema.safeParse({}).success).toBe(
      false
    );
    expect(
      searchSessionsOperation.inputSchema.safeParse({ query: "   " }).success
    ).toBe(false);
  });

  it("rejects an EMPTY sourceTypes array rather than reading it as 'all'", async () => {
    // `[]` is the dangerous spelling: without `.min(1)` it serializes to no
    // filter, silently widening a deliberately narrowed search back to every
    // surface.
    expect(
      searchSessionsOperation.inputSchema.safeParse({
        query: "refund",
        sourceTypes: [],
      }).success
    ).toBe(false);
  });

  it("rejects a blank query inside execute(), not only in the schema", async () => {
    // The CLI binding and other raw callers reach `execute` without parsing
    // the schema, and the endpoint reads a blank `q` as an EMPTY SEARCH — so
    // an unguarded blank would return the project's recency feed from an
    // operation that promises never to list.
    const { client, fetchMock } = makeClient();

    await expect(
      searchSessionsOperation.execute({ query: "   " }, { client })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(callsTo(fetchMock, "/sessions")).toHaveLength(0);
  });

  it("omits nextCursor entirely on the last page", async () => {
    // Absent, not `undefined`: callers that test with `in` or serialize the
    // result can tell the difference.
    const { client } = makeClient({
      sessionsEnvelope: { items: SESSION_SUMMARIES, scope: "titles" },
    });

    const result = await searchSessionsOperation.execute(
      { query: "refund" },
      { client }
    );
    expect("nextCursor" in result).toBe(false);
  });

  it("rejects an unknown scope", async () => {
    expect(
      searchSessionsOperation.inputSchema.safeParse({
        query: "refund",
        scope: "bodies",
      }).success
    ).toBe(false);
  });

  it("fails CLOSED when an old backend answers a transcript search with no scope marker", async () => {
    // The skew case: a deployment that predates `scope` ignores the unknown
    // param, runs a TITLE search, and returns 200. Handing those rows back as
    // transcript results would be an answer the caller cannot tell is wrong.
    const { client } = makeClient({
      sessionsEnvelope: { items: SESSION_SUMMARIES },
    });

    await expect(
      searchSessionsOperation.execute(
        { query: "refund", scope: "transcripts" },
        { client }
      )
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("scope=titles"),
    });
  });

  it("also fails closed when the backend echoes a DIFFERENT scope", async () => {
    const { client } = makeClient({
      sessionsEnvelope: { items: SESSION_SUMMARIES, scope: "titles" },
    });

    await expect(
      searchSessionsOperation.execute(
        { query: "refund", scope: "transcripts" },
        { client }
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("does NOT require the marker for a titles search", async () => {
    // An old backend runs a title search anyway, so its unmarked answer is
    // correct. Demanding the marker here would break every current caller
    // against an older deployment for no safety gain.
    const { client } = makeClient({
      sessionsEnvelope: { items: SESSION_SUMMARIES },
    });

    const result = await searchSessionsOperation.execute(
      { query: "refund" },
      { client }
    );
    expect(result.scope).toBe("titles");
    expect(result.items).toEqual(SESSION_SUMMARIES);
  });

  it("returns each item's link so a caller can open what it found", async () => {
    const { client } = makeClient();
    const result = await searchSessionsOperation.execute(
      { query: "refund" },
      { client }
    );
    expect(result.items[0]?.link.path).toContain("/playground?conversation=");
    expect(result.items[0]?.link.url).toContain("https://");
  });
});

describe("operation catalog consistency", () => {
  const MINIMAL_INPUTS: Record<string, Record<string, unknown>> = {
    get_me: {},
    list_models: {},
    list_organizations: {},
    list_projects: {},
    create_project: { name: "p" },
    update_project: { project: "p", name: "renamed" },
    delete_project: { project: "p" },
    list_project_servers: {},
    create_project_server: {
      body: { name: "s", enabled: true, transportType: "http" },
    },
    get_project_server: { serverId: "s" },
    update_project_server: { serverId: "s", body: { name: "renamed" } },
    delete_project_server: { serverId: "s" },
    show_servers: {},
    connect_project_server: { url: "https://example.com/mcp" },
    get_project_server_connection_status: { connectionRequestId: "scr_abc" },
    cancel_project_server_connection: { connectionRequestId: "scr_abc" },
    diagnose_server: { server: "s" },
    validate_server: { server: "s" },
    export_server: { server: "s" },
    list_server_tools: { server: "s" },
    list_server_prompts: { server: "s" },
    list_server_resources: { server: "s" },
    call_server_tool: { server: "s", toolName: "t" },
    get_server_prompt: { server: "s", promptName: "p" },
    read_server_resource: { server: "s", uri: "u" },
    list_server_skills: { server: "s" },
    get_server_skill: { server: "s", uri: "u" },
    read_server_skill_file: { server: "s", skillUri: "u", resourceUri: "r" },
    check_host_compatibility: { server: "s" },
    start_claude_readiness_run: { server: "s" },
    start_openai_readiness_run: { server: "s", submissionMode: "mcp-only" },
    get_readiness_run: { run: "r" },
    list_readiness_runs: {},
    cancel_readiness_run: { run: "r" },
    get_readiness_report: { run: "r" },
    start_conformance_run: { server: "s" },
    get_conformance_run: { run: "r" },
    list_conformance_runs: {},
    get_conformance_report: { run: "r" },
    list_eval_suites: {},
    list_eval_suite_runs: { suite: "s" },
    run_eval_suite: { suite: "s" },
    run_eval_case: { suite: "s", case: "c" },
    create_eval_suite: {
      name: "s",
      model: "anthropic/claude-haiku-4.5",
      servers: ["echo"],
      cases: [
        { title: "t", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] },
      ],
    },
    get_eval_suite: { suite: "s" },
    get_eval_run_disclosure: { suite: "s" },
    update_eval_suite: { suite: "s", name: "renamed" },
    delete_eval_suite: { suite: "s" },
    set_eval_suite_schedule: { suite: "s", enabled: false },
    set_eval_suite_environments: { suite: "s", environments: ["e"] },
    list_eval_cases: { suite: "s" },
    get_eval_case: { suite: "s", case: "c" },
    create_eval_case: {
      suite: "s",
      title: "c",
      steps: [{ id: "s1", kind: "prompt", prompt: "q" }],
    },
    create_eval_cases: {
      suite: "s",
      cases: [
        { title: "c", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] },
      ],
    },
    update_eval_case: { suite: "s", case: "c", title: "renamed" },
    delete_eval_case: { suite: "s", case: "c" },
    generate_eval_cases: { suite: "s", prompt: "q" },
    get_eval_run: { project: "p", runId: "r" },
    get_eval_run_stage_analytics: { project: "p", runId: "r" },
    list_eval_suite_stage_analytics: { project: "p", suite: "s" },
    // baseRunId is deliberately absent from the minimal input: omitting it is
    // the common path (compare against the nearest completed predecessor).
    compare_eval_run: { project: "p", runId: "r" },
    list_eval_run_iterations: { project: "p", runId: "r" },
    get_eval_iteration_trace: { project: "p", runId: "r", iterationId: "i" },
    cancel_eval_run: { project: "p", runId: "r" },
    waive_eval_gate: {
      project: "p",
      runId: "r",
      reason: "shipping the hotfix; tracked in ENG-1",
      expiresAt: 1_700_000_000_000,
    },
    get_eval_gate_waiver: { project: "p", runId: "r" },
    revoke_eval_gate_waiver: { project: "p", runId: "r", waiverId: "w" },
    request_eval_run_judge: { project: "p", runId: "r" },
    list_eval_check_repos: {},
    connect_eval_check_repo: {
      suite: "s",
      repo: "acme/widgets",
      // No default: the policy decides what other people's pull requests
      // report during an outage, so every caller states it.
      outagePolicy: "fail_open",
    },
    get_eval_run_steps: { project: "p", runId: "r", iterationId: "i" },
    create_tunnel: { name: "t" },
    close_tunnel: { serverId: "s" },
    list_scenarios: {},
    get_scenario: { scenario: "c" },
    list_chat_sessions: {},
    list_journeys: {},
    list_journey_runs: { journey: "j" },
    get_journey_run: { run: "r" },
    list_journey_run_sessions: { run: "r" },
    launch_journey_run: { journey: "j" },
    cancel_journey_run: { run: "r" },
    publish_scenario: { environment: "e" },
    unpublish_scenario: { environment: "e" },
    get_capabilities: {},
    list_personas: {},
    get_persona: { persona: "pe" },
    create_persona: { name: "Ada", role: "buyer" },
    update_persona: { persona: "pe", name: "Ada" },
    delete_persona: { persona: "pe" },
    list_secrets: {},
    get_secret: { secret: "sec" },
    // `delivery` is REQUIRED with no default, which is the point: a caller who
    // has not said whether the value ends up inside the sandbox has not made
    // the decision this operation exists to make.
    create_secret: {
      name: "STRIPE_API_KEY",
      value: "sk_live_example_value",
      delivery: "materialized",
    },
    update_secret: { secret: "sec", value: "sk_live_rotated_value" },
    delete_secret: { secret: "sec" },
    generate_personas: { environmentId: "e" },
    get_journey: { journey: "j" },
    create_journey: {
      goal: "buy a thing",
      persona: "pe",
      sessionsPerTarget: 1,
      maxTurns: 8,
    },
    update_journey: { journey: "j", goal: "buy two things" },
    archive_journey: { journey: "j" },
    generate_journeys: {
      environmentId: "e",
      persona: { name: "Ada", role: "buyer" },
    },
    list_swarms: {},
    get_swarm: { swarm: "sw" },
    create_swarm: { name: "checkout", sessionsPerTarget: 1, maxTurns: 8 },
    update_swarm: { swarm: "sw", name: "checkout v2" },
    archive_swarm: { swarm: "sw" },
    get_swarms_overview: {},
    get_journey_run_scorecard: { run: "r" },
    list_swarm_findings: {},
    dismiss_swarm_finding: { finding: "f" },
    undismiss_swarm_finding: { finding: "f" },
    get_wave_insights: { wave: "w" },
    request_wave_insights: { wave: "w" },
    cancel_wave_insights: { wave: "w" },
    get_user_testing_scenario: { scenario: "cb" },
    update_user_testing_scenario: { scenario: "cb", name: "Checkout" },
    list_user_testing_sessions: { scenario: "cb" },
    get_user_testing_session: { scenario: "cb", session: "s" },
    get_user_testing_metrics: { scenario: "cb" },
    get_user_testing_usage: { scenario: "cb" },
    list_user_testing_findings: { scenario: "cb" },
    get_user_testing_signals: { scenario: "cb" },
    get_user_testing_insights: { scenario: "cb", window: "w" },
    request_user_testing_insights: { scenario: "cb" },
    cancel_user_testing_insights: { scenario: "cb", window: "w" },
    dismiss_user_testing_finding: { scenario: "cb", finding: "f" },
    undismiss_user_testing_finding: { scenario: "cb", finding: "f" },
    set_user_testing_guest_execution: {
      scenario: "cb",
      enabled: true,
      computerEnabled: false,
      sharedSkillsEnabled: false,
      dailyCreditCap: 100,
      dailyComputerStartCap: 0,
      maxConcurrentComputers: 0,
    },
    rotate_user_testing_link: { scenario: "cb" },
    get_share_settings: { resourceType: "scenario", resourceId: "cb" },
    set_share_mode: {
      resourceType: "scenario",
      resourceId: "cb",
      mode: "project_members",
    },
    rotate_share_link: { resourceType: "scenario", resourceId: "cb" },
    upsert_user_testing_member: { scenario: "cb", email: "a@example.com" },
    remove_user_testing_member: { scenario: "cb", member: "a@example.com" },
    rebind_user_testing_scenario: { scenario: "cb", environmentId: "env_1" },
    get_share_settings: { resourceType: "scenario", resourceId: "s1" },
    set_share_mode: {
      resourceType: "scenario",
      resourceId: "s1",
      mode: "project_members",
    },
    rotate_share_link: { resourceType: "scenario", resourceId: "s1" },
    list_clients: {},
    get_client: { client: "c" },
    set_client_servers: {
      client: "c",
      serverIds: [],
      expectedConfigId: "hc_1",
    },
    duplicate_client: { client: "c" },
    create_client: { name: "c", template: "claude" },
    update_client: { client: "c", name: "renamed", expectedName: "c" },
    delete_client: { client: "c" },
    list_project_environments: {},
    get_project_environment_capabilities: {},
    list_project_plugins: {},
    get_plugin_version: { pluginVersionId: "pv" },
    list_project_skills: {},
    get_project_skill: { skillId: "sk" },
    get_project_environment: { environment: "e" },
    resolve_project_environment: { environment: "e" },
    create_project_environment: { name: "e", hostId: "h" },
    ensure_adhoc_environment: { host: "h" },
    name_environment: { environment: "e", expectedRevision: 0, name: "n" },
    update_project_environment: {
      environment: "e",
      expectedRevision: 0,
      name: "renamed",
    },
    archive_project_environment: { environment: "e", expectedRevision: 0 },
    restore_project_environment: { environment: "e", expectedRevision: 0 },
    list_sandbox_images: {},
    get_sandbox_image: { image: "i" },
    create_sandbox_image: { name: "i", blueprint: "base: ubuntu@sha256:abc" },
    update_sandbox_image: { image: "i", name: "renamed" },
    validate_sandbox_image_blueprint: { blueprint: "base: ubuntu@sha256:abc" },
    build_sandbox_image: { image: "i" },
    list_sandbox_image_builds: { image: "i" },
    promote_sandbox_image: { image: "i" },
    use_sandbox_image: { image: "i" },
    reset_computer: {},
    search_sessions: { query: "q" },
    send_chat_message: {
      idempotencyKey: "k",
      message: "hi",
      project: "p",
      modelId: "anthropic/claude-sonnet-5",
      serverIds: ["srv"],
    },
    get_chat_session: { sessionId: "cs_1" },
    get_chat_session_trace: { sessionId: "cs_1" },
    render_server_widget: { server: "srv", toolName: "show_map" },
    delete_sandbox_image: { image: "i" },
    search_registry_directory: {},
    get_registry_directory_server: { catalogServerId: "cs" },
    list_registry_directory_sources: {},
    list_registry_servers: {},
    list_registry_connections: {},
    install_registry_directory_server: { catalogServerId: "cs" },
    install_registry_server: { registryServerId: "rs" },
    uninstall_registry_server: { registryServerId: "rs" },
  };

  it("keeps tool-safe names and accepts each operation's minimal input", () => {
    expect(Object.keys(MINIMAL_INPUTS).sort()).toEqual(
      ALL_OPERATIONS.map((operation) => operation.name).sort()
    );
    expect(
      new Set(ALL_OPERATIONS.map((operation) => operation.name)).size
    ).toBe(ALL_OPERATIONS.length);
    for (const operation of ALL_OPERATIONS) {
      const minimalInput = MINIMAL_INPUTS[operation.name];
      expect(
        minimalInput,
        `missing fixture for ${operation.name}`
      ).toBeDefined();
      expect(operation.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(operation.inputSchema.safeParse(minimalInput).success).toBe(true);
    }
    expect(
      showServersOperation.inputSchema.safeParse({ project: "" }).success
    ).toBe(false);
    expect(runEvalSuiteOperation.inputSchema.safeParse({}).success).toBe(false);
    expect(
      runEvalSuiteOperation.inputSchema.safeParse({ suite: "s", servers: [] })
        .success
    ).toBe(false);
  });

  it("declares the frozen card-install shape, so a strict re-validation keeps it", () => {
    // The inspector's proposal freeze injects a display-only `endpointUrl`
    // (resolved from the card) next to the `expectedUpdatedAt` pin. Both must
    // be schema-declared: a future strict re-validation at the execute seam
    // would otherwise reject every approved card install.
    expect(
      installRegistryServerOperation.inputSchema.safeParse({
        registryServerId: "rs",
        endpointUrl: "https://mcp.example.com/mcp",
        expectedUpdatedAt: 1_700_000_000_000,
      }).success
    ).toBe(true);
    expect(
      installRegistryServerOperation.inputSchema.safeParse({
        registryServerId: "rs",
        endpointUrl: "file:///etc/passwd",
        expectedUpdatedAt: 1_700_000_000_000,
      }).success
    ).toBe(false);
    expect(
      installRegistryDirectoryServerOperation.inputSchema.safeParse({
        catalogServerId: "cs",
        endpointUrl: "javascript:alert(1)",
      }).success
    ).toBe(false);
  });

  it("marks every operation read-only except the run/call/tunnel writes", () => {
    const writes = new Set([
      // Creates a durable run that dials a third party's server, and — with
      // the opt-in — spends the organization's credits.
      "start_claude_readiness_run",
      "start_openai_readiness_run",
      "start_conformance_run",
      // Stops one. A write because it changes the row, spending nothing.
      "cancel_readiness_run",
      "run_eval_suite",
      "run_eval_case",
      "cancel_eval_run",
      // Stops a pending connection, releasing the slot it holds.
      "cancel_project_server_connection",
      "request_eval_run_judge",
      "connect_eval_check_repo",
      "create_eval_suite",
      "set_eval_suite_environments",
      "call_server_tool",
      "create_tunnel",
      "close_tunnel",
      "create_project_server",
      "update_project_server",
      // Creates a connection request, and possibly a disabled server row.
      "connect_project_server",
      "delete_project_server",
      "create_project",
      "update_project",
      "delete_project",
      "archive_project_environment",
      "update_eval_suite",
      "delete_eval_suite",
      "set_eval_suite_schedule",
      "create_eval_case",
      "create_eval_cases",
      "update_eval_case",
      "delete_eval_case",
      "generate_eval_cases",
      "create_client",
      "update_client",
      "delete_client",
      "set_client_servers",
      "duplicate_client",
      "create_project_environment",
      "ensure_adhoc_environment",
      "name_environment",
      // Launching starts a fan-out that SPENDS model credits — the most
      // consequential write on this surface.
      "launch_journey_run",
      // Cancelling settles a run's attempts — a state change, not a read.
      "cancel_journey_run",
      // Scenarios: publishing exposes an environment to people outside the
      // project, unpublishing tears that down. Both are writes.
      "publish_scenario",
      "unpublish_scenario",
      "update_project_environment",
      "restore_project_environment",
      "create_sandbox_image",
      "update_sandbox_image",
      "build_sandbox_image",
      "promote_sandbox_image",
      "use_sandbox_image",
      "reset_computer",
      "delete_sandbox_image",
      // Swarms authoring. Creating a persona or a journey persists but starts
      // nothing and spends nothing — `launch_journey_run` above is the call
      // that costs.
      "create_persona",
      "update_persona",
      "delete_persona",
      // Secret writes. `create_secret` and `update_secret` carry a credential
      // in their INPUT (risk: exposure); `delete_secret` revokes one.
      "create_secret",
      "update_secret",
      "delete_secret",
      "create_journey",
      "update_journey",
      "archive_journey",
      "create_swarm",
      "update_swarm",
      "archive_swarm",
      // Generation persists NOTHING — it returns drafts — but it runs a model
      // on the organization's account, and a read that spends is a lie about
      // what calling it costs.
      "generate_personas",
      "generate_journeys",
      // Insights: dismissal is a judgement someone recorded, and requesting a
      // pass spends against the org's shared daily budget.
      "dismiss_swarm_finding",
      "undismiss_swarm_finding",
      "request_wave_insights",
      "cancel_wave_insights",
      // User testing writes. The exposure controls are the reason `risk`
      // exists as a separate axis from `readOnly`: rotating a link and
      // dismissing a finding are both writes, and only one of them can lock
      // people out of a live scenario.
      "update_user_testing_scenario",
      "request_user_testing_insights",
      "cancel_user_testing_insights",
      "dismiss_user_testing_finding",
      "undismiss_user_testing_finding",
      "set_user_testing_guest_execution",
      "rotate_user_testing_link",
      "set_share_mode",
      "rotate_share_link",
      "upsert_user_testing_member",
      "remove_user_testing_member",
      "rebind_user_testing_scenario",
      "set_share_mode",
      "rotate_share_link",
      "install_registry_directory_server",
      "install_registry_server",
      "uninstall_registry_server",
      // Executes the tool, then renders its widget. A write for the same
      // reason `call_server_tool` is: the tool runs.
      "render_server_widget",
      // One agent Playground turn. A write because it appends to a durable
      // transcript, and `risk: "spend"` because it runs a model — the two
      // reads beside it (get_chat_session, get_chat_session_trace) stay reads.
      "send_chat_message",
      // Gate waivers. Both are writes because both persist an audited record
      // and both move a published GitHub Check Run. `get_eval_gate_waiver` is
      // deliberately NOT here — reading whether a gate is waived is available
      // to anyone who can view the run, and a waiver its readers cannot see
      // is not a visible waiver.
      "waive_eval_gate",
      "revoke_eval_gate_waiver",
    ]);
    for (const operation of ALL_OPERATIONS) {
      expect(operation.readOnly).toBe(!writes.has(operation.name));
    }
    expect(
      [...writes].filter(
        (name) => !ALL_OPERATIONS.some((op) => op.name === name)
      )
    ).toEqual([]);
  });

  it("flags only operations with unknowable side effects as may-be-destructive", () => {
    const destructive = new Set([
      "call_server_tool",
      "archive_project_environment",
      // It IS a tool call — the render is what happens afterwards — so it
      // inherits `call_server_tool`'s unknowability exactly.
      "render_server_widget",
      // Under `toolMode: "auto"` this executes arbitrary third-party tools,
      // which is `call_server_tool`'s unknowability with a model choosing the
      // arguments. Softening the destructive default would claim a safety the
      // host cannot verify, since `readOnlyHint` is server-asserted.
      "send_chat_message",
    ]);
    for (const operation of ALL_OPERATIONS) {
      expect(operation.mayBeDestructive === true).toBe(
        destructive.has(operation.name)
      );
    }
  });
});

describe("server live operations", () => {
  it("diagnose_server resolves the server by name and posts the doctor op", async () => {
    const { client, fetchMock } = makeClient({ servers: HTTP_SERVERS });

    const result = await diagnoseServerOperation.execute(
      { project: "new", server: "echo" },
      { client }
    );

    expect(result.server).toEqual({ id: "server-http", name: "Echo" });
    expect(result.report).toEqual({ status: "healthy", checks: [] });
    expect(callsTo(fetchMock, "/doctor")[0]!.pathname).toBe(
      "/api/v1/projects/project-new/servers/server-http/doctor"
    );
  });

  it("rejects stdio servers deterministically before any live call", async () => {
    const { client, fetchMock } = makeClient();

    await expect(
      diagnoseServerOperation.execute(
        { project: "new", server: "Docs" },
        { client }
      )
    ).rejects.toThrow(/stdio servers are not supported/);
    expect(callsTo(fetchMock, "/doctor")).toHaveLength(0);
  });

  it("list_server_tools forwards the cursor and surfaces nextCursor", async () => {
    const { client } = makeClient({ servers: HTTP_SERVERS });

    const result = await listServerToolsOperation.execute(
      { project: "new", server: "Echo", cursor: "page-2" },
      { client }
    );

    expect(result.items).toEqual([{ name: "echo", cursorSeen: "page-2" }]);
    expect(result.nextCursor).toBe("tools-page-2");
  });

  // MCP 2026-07-28 `server/utilities/pagination`: "an empty string is a valid
  // cursor and thus MUST NOT be treated as the end of results". These listings
  // are a PASSTHROUGH of the MCP server's cursor, so the rule reaches them.
  it("accepts an empty-string cursor and puts it on the wire", () => {
    const parsed = listServerToolsOperation.inputSchema.safeParse({
      project: "new",
      server: "Echo",
      cursor: "",
    });
    // A `.min(1)` here would refuse to page a conforming server.
    expect(parsed.success).toBe(true);
  });

  it("list_server_tools forwards an empty-string cursor verbatim", async () => {
    const { client } = makeClient({ servers: HTTP_SERVERS });

    const result = await listServerToolsOperation.execute(
      { project: "new", server: "Echo", cursor: "" },
      { client }
    );

    expect(result.items).toEqual([{ name: "echo", cursorSeen: "" }]);
  });

  it("list_server_tools surfaces an empty-string nextCursor instead of dropping it", async () => {
    const { client } = makeClient({ servers: HTTP_SERVERS });

    const result = await listServerToolsOperation.execute(
      { project: "new", server: "Echo", cursor: "penultimate" },
      { client }
    );

    expect(result.nextCursor).toBe("");
    expect("nextCursor" in result).toBe(true);
  });

  it("call_server_tool defaults parameters and posts the call body", async () => {
    const { client } = makeClient({ servers: HTTP_SERVERS });

    const result = await callServerToolOperation.execute(
      { project: "new", server: "Echo", toolName: "echo" },
      { client }
    );

    expect(result.result.requestBody).toEqual({
      toolName: "echo",
      parameters: {},
    });
  });

  it("get_server_prompt and read_server_resource post their payloads", async () => {
    const { client } = makeClient({ servers: HTTP_SERVERS });

    const prompt = await getServerPromptOperation.execute(
      {
        project: "new",
        server: "Echo",
        promptName: "summarize",
        arguments: { style: "brief" },
      },
      { client }
    );
    expect(prompt.result.requestBody).toEqual({
      promptName: "summarize",
      arguments: { style: "brief" },
    });

    const resource = await readServerResourceOperation.execute(
      { project: "new", server: "Echo", uri: "file:///a" },
      { client }
    );
    expect(resource.result.requestBody).toEqual({ uri: "file:///a" });
  });
});

describe("createHostOperation input", () => {
  const CONFIG = { hostStyle: "claude", systemPrompt: "" } as const;

  it("requires a pinned model on the config branch", () => {
    // The forward-client invariant: a client minted without a model cannot back
    // a headless environment, and the failure would surface at LAUNCH rather
    // than here. Checked in the schema so an SDK caller is told by the contract
    // instead of by a 400 it never predicted.
    expect(
      createHostOperation.inputSchema.safeParse({ name: "h", config: CONFIG })
        .success
    ).toBe(false);
    expect(
      createHostOperation.inputSchema.safeParse({
        name: "h",
        config: { ...CONFIG, modelId: "   " },
      }).success
    ).toBe(false);
    expect(
      createHostOperation.inputSchema.safeParse({
        name: "h",
        config: { ...CONFIG, modelId: "anthropic/claude-sonnet-4-5" },
      }).success
    ).toBe(true);
  });

  it("reports a degenerate `config: {}` the way the ROUTE does", () => {
    // `{}` is truthy but picks neither branch. The route answers "provide
    // exactly one of template or a non-empty config", and that 400 is the one a
    // caller actually receives — a schema that instead complained about the
    // missing model would predict an error the surface never returns.
    const result = createHostOperation.inputSchema.safeParse({
      name: "h",
      config: {},
    });
    expect(result.success).toBe(false);
    const messages = result.success
      ? []
      : result.error.issues.map((issue) => issue.message);
    expect(messages).toEqual([
      "Provide exactly one of `template` or a non-empty `config`.",
    ]);
  });

  it("keeps the template branch model-free", () => {
    // A template carries its own model; the guard is on the config the caller
    // hands over verbatim.
    expect(
      createHostOperation.inputSchema.safeParse({
        name: "h",
        template: "claude",
      }).success
    ).toBe(true);
  });
});

describe("registry operations", () => {
  /**
   * A client for the install flow: install → getProjectServer → mint link.
   * `connectionResponse` overrides the POST /server-connections answer;
   * `outcome` is what the install route reports.
   */
  function registryClient(options?: {
    outcome?: "created" | "reconnected";
    connectionResponse?: () => Response | Promise<Response>;
  }): { client: PlatformApiClient; fetchMock: ReturnType<typeof vi.fn> } {
    const fetchMock = vi.fn(async (target: unknown) => {
      const path = new URL(String(target)).pathname;
      if (path === "/api/v1/projects") {
        return Response.json({ items: PROJECTS });
      }
      if (
        /^\/api\/v1\/projects\/[^/]+\/registry\/directory-installs$/.test(path)
      ) {
        return Response.json({
          serverId: "server-installed",
          serverName: "Installed",
          outcome: options?.outcome ?? "created",
        });
      }
      if (
        /^\/api\/v1\/projects\/[^/]+\/servers\/server-installed$/.test(path)
      ) {
        return Response.json({
          id: "server-installed",
          projectId: "project-new",
          name: "Installed",
          enabled: true,
          transportType: "http",
          url: "https://mcp.example.com/mcp",
          useOAuth: true,
          hasClientSecret: false,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      if (path === "/api/v1/server-connections") {
        if (options?.connectionResponse) return options.connectionResponse();
        return Response.json({
          connectionRequestId: "conn-1",
          status: "pending",
          handoffUrl: "https://app.example.com/connect/tok",
        });
      }
      if (path === "/api/v1/registry/directory-servers") {
        return Response.json({ items: [] });
      }
      return Response.json(
        { code: "NOT_FOUND", message: `No route for ${path}` },
        { status: 404 }
      );
    });
    const client = new PlatformApiClient({
      baseUrl: "https://api.example.com/api/v1",
      getAuth: () => "sk_test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    return { client, fetchMock };
  }

  it("mints a connect link for a first-time OAuth install", async () => {
    const { client, fetchMock } = registryClient();

    const result = await installRegistryDirectoryServerOperation.execute(
      { project: "new", catalogServerId: "cs" },
      { client }
    );

    expect(result.outcome).toBe("created");
    expect(result.nextSteps.connectLinkUrl).toBe(
      "https://app.example.com/connect/tok"
    );
    expect(result.nextSteps.connectLinkError).toBeUndefined();
    expect(callsTo(fetchMock, "/server-connections")).toHaveLength(1);
  });

  it("does NOT mint a connect link on a repeat install (reconnected)", async () => {
    // The server row — and possibly a completed OAuth grant — already
    // existed. Minting here would orphan a single-use handoff token on every
    // repeat install; the status op tells the caller whether a new link is
    // even needed.
    const { client, fetchMock } = registryClient({ outcome: "reconnected" });

    const result = await installRegistryDirectoryServerOperation.execute(
      { project: "new", catalogServerId: "cs" },
      { client }
    );

    expect(result.outcome).toBe("reconnected");
    expect(result.nextSteps.connectLinkUrl).toBeUndefined();
    expect(result.nextSteps.connectLinkError).toBeUndefined();
    expect(callsTo(fetchMock, "/server-connections")).toHaveLength(0);
  });

  it("reports a failed link mint instead of silently omitting the link", async () => {
    const { client } = registryClient({
      connectionResponse: () =>
        Response.json(
          { code: "RATE_LIMITED", message: "Too many connection requests" },
          { status: 429 }
        ),
    });

    const result = await installRegistryDirectoryServerOperation.execute(
      { project: "new", catalogServerId: "cs" },
      { client }
    );

    // The install itself succeeded and stays a success…
    expect(result.serverId).toBe("server-installed");
    expect(result.nextSteps.connectLinkUrl).toBeUndefined();
    // …but the degradation is visible, not silent.
    expect(result.nextSteps.connectLinkError).toContain(
      "Too many connection requests"
    );
  });

  it("propagates the caller's abort instead of reporting success", async () => {
    const controller = new AbortController();
    const { client } = registryClient({
      connectionResponse: () => {
        controller.abort();
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        throw error;
      },
    });

    const error = await installRegistryDirectoryServerOperation
      .execute(
        { project: "new", catalogServerId: "cs" },
        { client, signal: controller.signal }
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  });

  it("forwards verifiedTier to the directory search", async () => {
    const { client, fetchMock } = registryClient();
    const input = searchRegistryDirectoryOperation.inputSchema.parse({
      verifiedTier: "verified",
    });

    await searchRegistryDirectoryOperation.execute(input, { client });

    const call = callsTo(fetchMock, "/registry/directory-servers")[0]!;
    expect(call.searchParams.get("verifiedTier")).toBe("verified");
  });

  it("refuses catalogServerId + source together rather than ignoring source", () => {
    expect(
      getRegistryDirectoryServerOperation.inputSchema.safeParse({
        catalogServerId: "cs",
        source: "claude",
      }).success
    ).toBe(false);
    expect(
      getRegistryDirectoryServerOperation.inputSchema.safeParse({
        name: "linear",
        source: "claude",
      }).success
    ).toBe(true);
  });
});
