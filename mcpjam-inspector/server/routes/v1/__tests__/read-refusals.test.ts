/**
 * MJ-021: cross-tenant READS must answer 404 (or 403 for a
 * refusal the backend states), never a 5xx.
 *
 * The refusal under test is the one production actually produces: the
 * backend's authorization helpers throw a plain error, and production Convex
 * redacts it to "Server Error" — indistinguishable, as a string, from a
 * crash. Every scoping read below must read that as the refusal it is and
 * answer the same 404 an unknown id gets, through the real router and the
 * real v1 error boundary, with no Convex framing in the body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const config = vi.hoisted(() => ({ hosted: false }));

vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return config.hosted;
    },
  };
});

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const convex = vi.hoisted(() => ({
  action: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = convex.setAuth;
    action = convex.action;
    query = convex.query;
    mutation = convex.mutation;
  },
}));

vi.mock("../../../utils/v1-convex-token.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/v1-convex-token.js")>();
  return {
    ...actual,
    getConvexBearerForRequest: vi.fn(async () => "bearer-token"),
  };
});

const { v1OnError } = await import("../envelope.js");
const { requestLogContextMiddleware } =
  await import("../../../middleware/request-log-context.js");
const { logger } = await import("../../../utils/logger.js");

/** A Convex document-id-shaped segment for the routes that gate id shape. */
const CONVEX_ID = "js7abc0def1ghj2klm3nop4qrs5tuv6w";

/** What a production deployment rejects with for a plain backend throw. */
const masked = () =>
  new Error("[CONVEX Q(fn)] [Request ID: 7d1b] Server Error");

/**
 * What a non-production deployment rejects with when a caller-supplied id
 * does not parse as the `v.id(...)` the function declares. (Production
 * redacts this to `masked()` above.)
 */
const invalidArgument = () =>
  new Error(
    '[CONVEX Q(fn)] [Request ID: 7d1b] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .projectId\nValue: "projotherxxxxxxxxxxxxxxxxxxxxxxx"\nValidator: v.id("projects")',
  );

/** What `ConvexHttpClient` rejects with for a `ConvexError`. */
function convexError(data: Record<string, unknown>): Error {
  return Object.assign(
    new Error(
      `[CONVEX Q(fn)] [Request ID: 7d1b] Server Error\nUncaught ConvexError: ${JSON.stringify(
        data,
      )}`,
    ),
    { data },
  );
}

function createApp(router: Hono): Hono {
  const app = new Hono();
  app.use("*", requestLogContextMiddleware);
  app.route("/api/v1", router);
  app.onError((error, c) => v1OnError(error, c));
  return app;
}

async function expectNoConvexFraming(response: Response) {
  const text = await response.clone().text();
  expect(text).not.toContain("Request ID: 7d1b");
  expect(text).not.toContain("Uncaught");
  expect(text).not.toContain("CONVEX Q(");
  expect(text).not.toContain("Server Error");
  expect(text).not.toContain("ArgumentValidationError");
  expect(text).not.toContain("Validator");
}

interface ReadFamily {
  family: string;
  /** Module under `routes/v1/`, imported after the mocks. */
  module: string;
  path: string;
  message: string;
}

/**
 * One representative cross-tenant read per changed family. Every one of these
 * answered 500 (raw escape, or the write translator's terminal branch) or 502
 * (the read classifier without `redactedIsRefusal`) before this change.
 */
const READ_FAMILIES: ReadFamily[] = [
  {
    family: "servers",
    module: "../servers.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/servers/srv-1",
    message: "Server not found",
  },
  {
    family: "agent jobs",
    module: "../agent.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/agent/jobs/job-1",
    message: "Agent job not found.",
  },
  {
    family: "eval suites",
    module: "../evals.js",
    path: `/api/v1/projects/js7abc0def1ghj2klm3nop4qrs5tuv6x/eval-suites/${CONVEX_ID}`,
    message: "Eval suite not found",
  },
  {
    family: "goals",
    module: "../goals.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/goals",
    message: "Not found",
  },
  {
    family: "personas",
    module: "../personas.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/personas",
    message: "Not found",
  },
  {
    family: "secrets",
    module: "../secrets.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/secrets",
    message: "Not found",
  },
  {
    family: "swarms",
    module: "../swarms.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/swarms",
    message: "Not found",
  },
  {
    family: "swarm insights",
    module: "../swarm-insights.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/goals-overview",
    message: "Not found",
  },
  {
    family: "plugins",
    module: "../plugins.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/plugins",
    message: "Plugin or project not found, or you do not have access.",
  },
  {
    family: "skills",
    module: "../skills.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/skills",
    message: "Skill or project not found, or you do not have access.",
  },
  {
    family: "capabilities",
    module: "../capabilities.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/capabilities",
    message: "Project not found",
  },
  {
    family: "spend budget",
    module: "../spend-budget.js",
    path: "/api/v1/organizations/org-other/spend-budget",
    message: "Not found",
  },
  {
    family: "eval check repos",
    module: "../eval-checks.js",
    path: "/api/v1/organizations/org-other/eval-check-repos",
    message: "Not found",
  },
  {
    family: "conformance runs",
    module: "../conformance-runs.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/conformance-runs",
    message: "Conformance runs not found",
  },
  {
    family: "readiness runs",
    module: "../readiness.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/readiness-runs/run-1",
    message: "Readiness run not found",
  },
  {
    family: "images",
    module: "../images.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/images",
    message:
      "Environment or project not found, or you do not have access to it.",
  },
  {
    family: "environments",
    module: "../environments.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/environments",
    message:
      "Environment or project not found, or you do not have access to it.",
  },
  {
    family: "server groups",
    module: "../server-groups.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/server-groups",
    message: "Server group not found",
  },
  {
    family: "clients",
    module: "../clients.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/clients",
    message: "Project or client not found, or you do not have access to it.",
  },
  {
    // Scoped by `hosts:resolveHostByNameOrId`, not the list read.
    family: "client detail",
    module: "../clients.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/clients/cl-1",
    message: "Project or client not found, or you do not have access to it.",
  },
  {
    // The deprecated alias has no resolver: `hosts:getHost` is the scoping
    // read, and its unknown-id answer is "Client not found".
    family: "legacy host detail",
    module: "../clients.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/hosts/h-1",
    message: "Client not found",
  },
  {
    family: "environment resolve",
    module: "../environments.js",
    path: "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/environments/env-1/resolve",
    message:
      "Environment or project not found, or you do not have access to it.",
  },
];

describe("cross-tenant reads answer 404, not a server fault (MJ-021)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.hosted = false;
    vi.stubEnv("CONVEX_URL", "https://convex.test");
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex-http.test");
    vi.spyOn(logger, "event").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  for (const { family, module, path, message } of READ_FAMILIES) {
    it(`${family}: a production-masked refusal answers 404`, async () => {
      convex.query.mockRejectedValue(masked());
      convex.action.mockRejectedValue(masked());
      const { default: router } = (await import(module)) as { default: Hono };

      const response = await createApp(router).request(path);

      expect(response.status).toBe(404);
      await expectNoConvexFraming(response);
      expect(await response.json()).toEqual({
        code: "NOT_FOUND",
        message,
      });
    });
  }

  it("keeps a stated authorization refusal a 403 on the server read", async () => {
    convex.query.mockRejectedValue(convexError({ kind: "forbidden" }));
    const { default: router } = (await import("../servers.js")) as {
      default: Hono;
    };

    const response = await createApp(router).request(
      "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/servers/srv-1",
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("FORBIDDEN");
  });

  it("still answers 401 for a bad credential rather than 404", async () => {
    convex.query.mockRejectedValue(new Error("Unauthenticated"));
    const { default: router } = (await import("../secrets.js")) as {
      default: Hono;
    };

    const response = await createApp(router).request(
      "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/secrets",
    );

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHORIZED");
  });

  const projectId = "js7abc0def1ghj2klm3nop4qrs5tuv6x";
  const suitePath = `/api/v1/projects/${projectId}/eval-suites/${CONVEX_ID}`;
  const runPath = `/api/v1/projects/${projectId}/eval-runs/${CONVEX_ID}`;
  const pageReads = [
    `${suitePath}/cases`,
    `${suitePath}/runs`,
    `${suitePath}/revisions`,
    `${suitePath}/stage-analytics`,
    `${runPath}/decision-summary`,
    `${runPath}/iterations`,
    `${runPath}/stage-analytics`,
    `${runPath}/gate`,
    `${runPath}/route-facts`,
    `${runPath}/server-facts`,
    `${runPath}/iterations/${CONVEX_ID}/trace`,
  ];

  it.each(pageReads)(
    "%s: a masked scope refusal still answers 404",
    async (path) => {
      convex.query.mockRejectedValue(masked());
      convex.action.mockRejectedValue(masked());
      const { default: router } = await import("../evals.js");
      const response = await createApp(router).request(path);
      expect(response.status).toBe(404);
      await expectNoConvexFraming(response);
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it.each(pageReads)(
    "%s: a masked failure after authorization answers 502",
    async (path) => {
      convex.query.mockImplementation(async (name: string) => {
        if (
          name === "testSuites:getTestSuite" ||
          name === "testSuites:getTestSuiteRun"
        ) {
          return { projectId, suiteId: CONVEX_ID };
        }
        if (name === "testSuites:getTestIteration")
          return { suiteRunId: CONVEX_ID };
        throw masked();
      });
      convex.action.mockRejectedValue(masked());
      const { default: router } = await import("../evals.js");
      const response = await createApp(router).request(path);
      expect(response.status).toBe(502);
      await expectNoConvexFraming(response);
      expect((await response.json()).code).toBe("SERVER_UNREACHABLE");
      expect(logger.error).toHaveBeenCalled();
    },
  );

  it.each([
    ["GET", "", { kind: "forbidden" }, 403, "FORBIDDEN"],
    [
      "GET",
      "",
      { code: "VALIDATION_ERROR", message: "Invalid authoring request" },
      400,
      "VALIDATION_ERROR",
    ],
    ["POST", "/commit", { kind: "forbidden" }, 403, "FORBIDDEN"],
    [
      "POST",
      "/commit",
      { code: "VALIDATION_ERROR", message: "Invalid authoring request" },
      400,
      "VALIDATION_ERROR",
    ],
  ] as const)(
    "authoring %s%s preserves typed refusal %j",
    async (method, suffix, data, status, code) => {
      convex.query.mockRejectedValue(convexError(data));
      const { default: router } = await import("../evals.js");
      const response = await createApp(router).request(
        `${suitePath}/authoring/${CONVEX_ID}${suffix}`,
        { method },
      );
      expect(response.status).toBe(status);
      await expectNoConvexFraming(response);
      expect((await response.json()).code).toBe(code);
      expect(convex.mutation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["/backtest", { assertions: { mode: "replace", list: [] } }],
    ["/judge/backtest", { rubric: null }],
  ])(
    "%s distinguishes a masked scope refusal from a later crash",
    async (suffix, body) => {
      const { default: router } = await import("../eval-backtest.js");
      const app = createApp(router);
      const request = () =>
        app.request(`${runPath}${suffix}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      convex.query.mockRejectedValue(masked());
      expect((await request()).status).toBe(404);
      expect(convex.action).not.toHaveBeenCalled();
      convex.query.mockResolvedValue({ projectId, suiteId: CONVEX_ID });
      convex.action.mockRejectedValue(masked());
      const response = await request();
      expect(response.status).toBe(502);
      await expectNoConvexFraming(response);
      expect(logger.error).toHaveBeenCalled();
    },
  );

  it.each([
    ["PATCH", "", { name: "Renamed suite" }],
    ["PATCH", "/schedule", { enabled: false }],
    [
      "POST",
      "/cases",
      {
        title: "Read tools",
        steps: [{ id: "s1", kind: "prompt", prompt: "Read tools" }],
      },
    ],
    ["PATCH", `/cases/${CONVEX_ID}`, { title: "Renamed case" }],
  ])(
    "%s %s keeps masked post-write read failures observable",
    async (method, suffix, body) => {
      let committed = false;
      convex.query.mockImplementation(async (name: string) => {
        if (committed) throw masked();
        if (name === "testSuites:getTestSuite")
          return { _id: CONVEX_ID, projectId };
        if (name === "testSuites:getTestCase")
          return {
            _id: CONVEX_ID,
            projectId,
            testSuiteId: CONVEX_ID,
            caseType: "prompt",
            title: "Read tools",
            query: "Read tools",
            runs: 1,
          };
        return null;
      });
      convex.mutation.mockImplementation(async (name: string) => {
        committed = true;
        if (name === "testSuites:createTestCases")
          return {
            caseUpsert: {
              committed: [
                {
                  index: 0,
                  title: "Read tools",
                  testCaseId: CONVEX_ID,
                  replayed: false,
                },
              ],
              failed: [],
            },
            duplicatePolicy: { effectivePolicy: "block", coerced: false },
            warnings: [],
          };
        return undefined;
      });
      const { default: router } = await import("../evals.js");
      const response = await createApp(router).request(
        `${suitePath}${suffix}`,
        {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(committed).toBe(true);
      expect(response.status).toBe(502);
      await expectNoConvexFraming(response);
      expect((await response.json()).code).toBe("SERVER_UNREACHABLE");
      expect(logger.error).toHaveBeenCalled();
    },
  );

  it("keeps a failed suite policy read after case authorization observable", async () => {
    convex.query.mockImplementation(async (name: string) => {
      if (name === "testSuites:getTestCase")
        return {
          _id: CONVEX_ID,
          projectId,
          testSuiteId: CONVEX_ID,
          caseType: "prompt",
        };
      throw masked();
    });
    const { default: router } = await import("../evals.js");
    const response = await createApp(router).request(
      `${suitePath}/cases/${CONVEX_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repetitions: 2 }),
      },
    );
    expect(response.status).toBe(502);
    await expectNoConvexFraming(response);
    expect(logger.error).toHaveBeenCalled();
    expect(convex.mutation).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "", undefined],
    ["GET", `/cases/${CONVEX_ID}`, undefined],
    ["POST", "/environments", { environmentId: CONVEX_ID }],
  ])(
    "%s %s retains masked refusal mapping on initial helper lookups",
    async (method, suffix, body) => {
      convex.query.mockRejectedValue(masked());
      const { default: router } = await import("../evals.js");
      const response = await createApp(router).request(
        `${suitePath}${suffix}`,
        {
          method,
          headers: { "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      expect(response.status).toBe(404);
      await expectNoConvexFraming(response);
      expect(logger.error).not.toHaveBeenCalled();
      expect(convex.mutation).not.toHaveBeenCalled();
    },
  );
});

/**
 * The read families that fall back to the WRITE translator. It has no branch
 * for a validator-rejected argument, so before this a malformed id on any of
 * them reached its terminal 500.
 */
const WRITE_TRANSLATOR_READS = new Set([
  "conformance runs",
  "readiness runs",
  "images",
  "environments",
  "server groups",
  "clients",
  "client detail",
  "legacy host detail",
  "environment resolve",
]);

describe("read routes on the write translator (MJ-021)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.hosted = false;
    vi.stubEnv("CONVEX_URL", "https://convex.test");
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex-http.test");
    vi.spyOn(logger, "event").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  for (const { family, module, path, message } of READ_FAMILIES.filter(
    ({ family }) => WRITE_TRANSLATOR_READS.has(family),
  )) {
    it(`${family}: a malformed id answers 404, not 500`, async () => {
      convex.query.mockRejectedValue(invalidArgument());
      const { default: router } = (await import(module)) as { default: Hono };

      const response = await createApp(router).request(path);

      expect(response.status).toBe(404);
      await expectNoConvexFraming(response);
      expect(await response.json()).toEqual({ code: "NOT_FOUND", message });
      // Not an incident, but not silent: deploy skew answers the same 404.
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("convex rejected read arguments"),
        expect.anything(),
      );
    });
  }

  it.each([
    ["a production-masked refusal", masked],
    ["a malformed id", invalidArgument],
  ])("blueprint validation answers 404 to %s", async (_label, failure) => {
    convex.query.mockRejectedValue(failure());
    const { default: router } = await import("../images.js");

    const response = await createApp(router).request(
      "/api/v1/projects/projotherxxxxxxxxxxxxxxxxxxxxxxx/images/validate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blueprint: "base: ubuntu" }),
      },
    );

    expect(response.status).toBe(404);
    await expectNoConvexFraming(response);
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      message:
        "Environment or project not found, or you do not have access to it.",
    });
  });

  it("keeps a stated client-resolver refusal on the write translator", async () => {
    // A `ConvexError` is a deliberate answer, not a masked one: the resolver's
    // own NOT_FOUND keeps its mapping and is not re-read here.
    convex.query.mockRejectedValue(
      convexError({ code: "NOT_FOUND", message: 'No client named "x"' }),
    );
    const { default: router } = await import("../clients.js");

    const response = await createApp(router).request(
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/clients/x",
    );

    expect(response.status).toBe(404);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("[v1.read-refusal]"),
      expect.anything(),
    );
  });

  describe("client writes are unchanged", () => {
    const resolved = async (name: string) => {
      if (name === "hosts:resolveHostByNameOrId") {
        return { hostId: "h1", name: "Alpha" };
      }
      if (name === "hosts:getHost") {
        return {
          hostId: "h1",
          name: "Alpha",
          config: { modelId: "gpt-4o-mini" },
        };
      }
      return null;
    };
    const postServers = (router: Hono) =>
      createApp(router).request("/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/clients/h1/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverIds: ["srv-1"], expectedConfigId: "hc1" }),
      });

    it("a validation refusal from the write keeps its 400", async () => {
      convex.query.mockImplementation(resolved);
      convex.mutation.mockRejectedValue(
        convexError({ code: "VALIDATION", message: "Unknown server id" }),
      );
      const { default: router } = await import("../clients.js");

      const response = await postServers(router);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Unknown server id",
      });
    });

    it.each([
      ["a production-masked failure", masked],
      ["a validator rejection", invalidArgument],
    ])(
      "%s on the write is not re-read as a missing client",
      async (_label, failure) => {
        convex.query.mockImplementation(resolved);
        convex.mutation.mockRejectedValue(failure());
        const { default: router } = await import("../clients.js");

        const response = await postServers(router);

        expect(response.status).toBe(500);
        await expectNoConvexFraming(response);
        expect((await response.json()).code).toBe("INTERNAL_ERROR");
      },
    );

    it("a masked failure re-reading the written client stays a 500", async () => {
      // The read-back follows a committed write of an id the backend just
      // accepted: a failure there is ours, and 404 would report the client
      // the caller just wrote as gone.
      let committed = false;
      convex.query.mockImplementation(async (name: string) => {
        if (committed && name === "hosts:getHost") throw masked();
        return resolved(name);
      });
      convex.mutation.mockImplementation(async () => {
        committed = true;
        return undefined;
      });
      const { default: router } = await import("../clients.js");

      const response = await postServers(router);

      expect(committed).toBe(true);
      expect(response.status).toBe(500);
      await expectNoConvexFraming(response);
      expect((await response.json()).code).toBe("INTERNAL_ERROR");
    });
  });
});
