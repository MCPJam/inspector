/**
 * MJ-021 retest #3: cross-tenant READS must answer 404 (or 403 for a
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

/** What `ConvexHttpClient` rejects with for a `ConvexError`. */
function convexError(data: Record<string, unknown>): Error {
  return Object.assign(
    new Error(
      `[CONVEX Q(fn)] [Request ID: 7d1b] Server Error\nUncaught ConvexError: ${JSON.stringify(data)}`,
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
    path: "/api/v1/projects/proj-other/servers/srv-1",
    message: "Server not found",
  },
  {
    family: "agent jobs",
    module: "../agent.js",
    path: "/api/v1/projects/proj-other/agent/jobs/job-1",
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
    path: "/api/v1/projects/proj-other/goals",
    message: "Not found",
  },
  {
    family: "personas",
    module: "../personas.js",
    path: "/api/v1/projects/proj-other/personas",
    message: "Not found",
  },
  {
    family: "secrets",
    module: "../secrets.js",
    path: "/api/v1/projects/proj-other/secrets",
    message: "Not found",
  },
  {
    family: "swarms",
    module: "../swarms.js",
    path: "/api/v1/projects/proj-other/swarms",
    message: "Not found",
  },
  {
    family: "swarm insights",
    module: "../swarm-insights.js",
    path: "/api/v1/projects/proj-other/goals-overview",
    message: "Not found",
  },
  {
    family: "plugins",
    module: "../plugins.js",
    path: "/api/v1/projects/proj-other/plugins",
    message: "Plugin or project not found, or you do not have access.",
  },
  {
    family: "skills",
    module: "../skills.js",
    path: "/api/v1/projects/proj-other/skills",
    message: "Skill or project not found, or you do not have access.",
  },
  {
    family: "capabilities",
    module: "../capabilities.js",
    path: "/api/v1/projects/proj-other/capabilities",
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
    path: "/api/v1/projects/proj-other/conformance-runs",
    message: "Conformance runs not found",
  },
  {
    family: "readiness runs",
    module: "../readiness.js",
    path: "/api/v1/projects/proj-other/readiness-runs/run-1",
    message: "Readiness run not found",
  },
  {
    family: "images",
    module: "../images.js",
    path: "/api/v1/projects/proj-other/images",
    message: "Environment or project not found, or you do not have access to it.",
  },
  {
    family: "environments",
    module: "../environments.js",
    path: "/api/v1/projects/proj-other/environments",
    message: "Environment or project not found, or you do not have access to it.",
  },
  {
    family: "server groups",
    module: "../server-groups.js",
    path: "/api/v1/projects/proj-other/server-groups",
    message: "Server group not found",
  },
  {
    family: "clients",
    module: "../clients.js",
    path: "/api/v1/projects/proj-other/clients",
    message: "Project or client not found, or you do not have access to it.",
  },
];

describe("cross-tenant reads answer 404, not a server fault (MJ-021)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.hosted = false;
    vi.stubEnv("CONVEX_URL", "https://convex.test");
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
      "/api/v1/projects/proj-other/servers/srv-1",
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
      "/api/v1/projects/proj-other/secrets",
    );

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHORIZED");
  });
});
