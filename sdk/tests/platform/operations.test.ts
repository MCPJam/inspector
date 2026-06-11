import { describe, expect, it, vi } from "vitest";
import {
  getChatboxOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  listChatboxesOperation,
  listChatSessionsOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listProjectServersOperation,
  listProjectsOperation,
  PlatformApiClient,
  PlatformApiError,
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
    if (/^\/api\/v1\/projects\/[^/]+\/chatboxes$/.test(path)) {
      return Response.json({ items: CHATBOXES });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/chatboxes\/[^/]+$/.test(path)) {
      return Response.json(CHATBOX_DETAIL);
    }
    if (path === "/api/v1/chat-sessions") {
      return Response.json({ items: SESSIONS });
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

  it("marks every operation read-only except run_eval_suite", () => {
    for (const { operation } of ALL_OPERATIONS) {
      expect(operation.readOnly).toBe(operation.name !== "run_eval_suite");
    }
  });
});
