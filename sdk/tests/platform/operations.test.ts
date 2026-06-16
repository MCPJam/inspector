import { describe, expect, it, vi } from "vitest";
import {
  callServerToolOperation,
  closeTunnelOperation,
  createEvalSuiteOperation,
  createTunnelOperation,
  diagnoseServerOperation,
  getChatboxOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  getServerPromptOperation,
  listChatboxesOperation,
  listChatSessionsOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listProjectServersOperation,
  listProjectsOperation,
  listServerPromptsOperation,
  listServerResourcesOperation,
  listServerToolsOperation,
  PlatformApiClient,
  PlatformApiError,
  readServerResourceOperation,
  runEvalSuiteOperation,
  showServersOperation,
  type PlatformOperation,
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

const CHATBOXES = [
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

const CHATBOX_DETAIL = {
  ...CHATBOXES[0],
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

type FixtureOverrides = {
  servers?: unknown[];
  suites?: unknown[];
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
    if (/^\/api\/v1\/projects\/[^/]+\/eval-suites$/.test(path)) {
      return Response.json({ items: suites });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/eval-suites\/[^/]+\/runs$/.test(path)) {
      return Response.json({ items: [RUN] });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/eval-runs$/.test(path)) {
      expect(init?.method).toBe("POST");
      const requestBody = JSON.parse(String(init?.body)) as {
        serverIds?: string[];
      };
      return Response.json(
        {
          runId: "run-9",
          suiteId: "suite-1",
          status: "running",
          caseUpsert: { committed: [], failed: [] },
          // Mirrors the API: explicit serverIds echo back; an omitted set
          // resolves server-side to the suite's saved selection.
          servers: requestBody.serverIds
            ? requestBody.serverIds.map((id) => ({ id }))
            : [{ id: "server-saved", name: "Saved" }],
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
    if (/^\/api\/v1\/projects\/[^/]+\/chatboxes$/.test(path)) {
      return Response.json({ items: CHATBOXES });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/chatboxes\/[^/]+$/.test(path)) {
      return Response.json(CHATBOX_DETAIL);
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
        nextCursor: "tools-page-2",
      });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/servers\/[^/]+\/tools\/call$/.test(path)) {
      const requestBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return Response.json({ content: [{ type: "text", text: "ok" }], requestBody });
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
            query: "say hi",
            expectedToolCalls: ["echo", { toolName: "ping", arguments: { x: 1 } }],
          },
        ],
      },
      { client }
    );

    expect(result.suite).toEqual({ id: "suite-created", name: "Authored smoke" });
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
      query: "say hi",
      expectedToolCalls: ["echo", { toolName: "ping", arguments: { x: 1 } }],
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
          cases: [{ title: "t", query: "q" }],
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
          query: "q",
          advancedConfig: { system: "be terse", temperature: 0.2 },
          matchOptions: { caseSensitive: false },
          predicates: { mode: "replace", list: [] },
          caseType: "prompt",
          promptTurns: [{ role: "user", content: "hi" }],
        },
      ],
    }) as {
      cases: Array<Record<string, unknown>>;
    };
    const authored = parsed.cases[0]!;
    expect(authored.advancedConfig).toEqual({
      system: "be terse",
      temperature: 0.2,
    });
    expect(authored.matchOptions).toEqual({ caseSensitive: false });
    expect(authored.predicates).toEqual({ mode: "replace", list: [] });
    expect(authored.caseType).toBe("prompt");
    expect(authored.promptTurns).toEqual([{ role: "user", content: "hi" }]);
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
        cases: [{ title: "t", query: "q" }],
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
});

describe("chatbox operations", () => {
  it("lists the project's chatboxes", async () => {
    const { client } = makeClient();

    const result = await listChatboxesOperation.execute({}, { client });

    expect(result.project.id).toBe("project-new");
    expect(result.items).toEqual(CHATBOXES);
  });

  it("resolves a chatbox by name and fetches its detail", async () => {
    const { client, fetchMock } = makeClient();

    const result = await getChatboxOperation.execute(
      { chatbox: "support" },
      { client }
    );

    expect(result.chatbox).toEqual(CHATBOX_DETAIL);
    expect(callsTo(fetchMock, "/chatboxes/box-1")[0]?.pathname).toBe(
      "/api/v1/projects/project-new/chatboxes/box-1"
    );
  });

  it("lists the available chatboxes when the selector misses", async () => {
    const { client } = makeClient();

    const error = await getChatboxOperation
      .execute({ chatbox: "missing" }, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toContain(
      "Support (id: box-1)"
    );
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

describe("operation catalog consistency", () => {
  const ALL_OPERATIONS: Array<{
    operation: PlatformOperation<any, any>;
    minimalInput: Record<string, unknown>;
  }> = [
    { operation: listProjectsOperation, minimalInput: {} },
    { operation: listProjectServersOperation, minimalInput: {} },
    { operation: showServersOperation, minimalInput: {} },
    { operation: listEvalSuitesOperation, minimalInput: {} },
    { operation: listEvalSuiteRunsOperation, minimalInput: { suite: "s" } },
    { operation: runEvalSuiteOperation, minimalInput: { suite: "s" } },
    {
      operation: createEvalSuiteOperation,
      minimalInput: {
        name: "s",
        model: "anthropic/claude-haiku-4.5",
        servers: ["echo"],
        cases: [{ title: "t", query: "q" }],
      },
    },
    {
      operation: getEvalRunOperation,
      minimalInput: { project: "p", runId: "r" },
    },
    {
      operation: listEvalRunIterationsOperation,
      minimalInput: { project: "p", runId: "r" },
    },
    {
      operation: getEvalIterationTraceOperation,
      minimalInput: { project: "p", runId: "r", iterationId: "i" },
    },
    { operation: listChatboxesOperation, minimalInput: {} },
    { operation: getChatboxOperation, minimalInput: { chatbox: "c" } },
    { operation: listChatSessionsOperation, minimalInput: {} },
    { operation: diagnoseServerOperation, minimalInput: { server: "s" } },
    { operation: listServerToolsOperation, minimalInput: { server: "s" } },
    {
      operation: callServerToolOperation,
      minimalInput: { server: "s", toolName: "t" },
    },
    { operation: listServerPromptsOperation, minimalInput: { server: "s" } },
    {
      operation: getServerPromptOperation,
      minimalInput: { server: "s", promptName: "p" },
    },
    { operation: listServerResourcesOperation, minimalInput: { server: "s" } },
    {
      operation: readServerResourceOperation,
      minimalInput: { server: "s", uri: "u" },
    },
    { operation: createTunnelOperation, minimalInput: { name: "t" } },
    { operation: closeTunnelOperation, minimalInput: { serverId: "s" } },
  ];

  it("keeps tool-safe names and accepts each operation's minimal input", () => {
    for (const { operation, minimalInput } of ALL_OPERATIONS) {
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

  it("marks every operation read-only except the run/call/tunnel writes", () => {
    const writes = new Set([
      "run_eval_suite",
      "create_eval_suite",
      "call_server_tool",
      "create_tunnel",
      "close_tunnel",
    ]);
    for (const { operation } of ALL_OPERATIONS) {
      expect(operation.readOnly).toBe(!writes.has(operation.name));
    }
  });

  it("flags only call_server_tool as may-be-destructive", () => {
    for (const { operation } of ALL_OPERATIONS) {
      expect(operation.mayBeDestructive === true).toBe(
        operation.name === "call_server_tool"
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
