/**
 * Reading a stored conformance run check by check over REST: the single-check
 * route and the report's pages. The harness is the one `conformance-runs.test.ts`
 * uses; Convex and the stored blobs are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  validateGuestTokenMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
  convexQueryMock,
  convexMutationMock,
  authorizeServerMock,
  executePersistedConformanceRunMock,
  assertAllowedHostedTargetUrlMock,
  drainState,
  takeConformanceStartSlotMock,
} = vi.hoisted(() => ({
  drainState: { draining: false },
  takeConformanceStartSlotMock: vi.fn(),
  validateGuestTokenMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
  authorizeServerMock: vi.fn(),
  executePersistedConformanceRunMock: vi.fn(),
  assertAllowedHostedTargetUrlMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));
vi.mock("../../../services/workos-client.js", () => ({
  getWorkOSClient: () => ({
    apiKeys: { createValidation: validateApiKeyMock },
  }),
}));
vi.mock("../../../services/identity.js", () => ({
  resolveUserByExternalId: resolveUserByExternalIdMock,
}));
vi.mock("../../../services/workos-key-bindings.js", () => ({
  lookupWorkosKeyBinding: lookupWorkosKeyBindingMock,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return {
      setAuth: vi.fn(),
      query: convexQueryMock,
      mutation: convexMutationMock,
    };
  }),
}));
vi.mock("../../../services/conformance-run-executor.js", () => ({
  executePersistedConformanceRun: executePersistedConformanceRunMock,
}));
vi.mock("../../../services/lifecycle/drain.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../services/lifecycle/drain.js")
    >();
  const real = actual.createDrainCoordinator();
  return {
    ...actual,
    serverDrain: { ...real, isDraining: () => drainState.draining },
  };
});
vi.mock(
  "../../../middleware/conformance-run-rate-limit.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../middleware/conformance-run-rate-limit.js")
    >()),
    takeConformanceStartSlot: (...args: unknown[]) =>
      takeConformanceStartSlotMock(...args),
  }),
);

vi.mock("../../web/auth.js", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("../../web/auth.js");
  return { ...actual, authorizeServer: authorizeServerMock };
});

vi.mock("../../../utils/hosted-egress-guard.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../utils/hosted-egress-guard.js")
    >();
  return {
    ...actual,
    assertAllowedHostedTargetUrl: (...args: unknown[]) =>
      assertAllowedHostedTargetUrlMock(...args),
  };
});

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null } = {},
): Promise<Response> {
  const { body, token = "tok" } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(
    makeApp().request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const BLOB = "https://storage.example.com/report.json";

function runRow(status: string, suites = ["protocol"]) {
  return {
    _id: "run_1",
    projectId: PROJECT,
    serverId: "s1",
    status,
    requestedSuites: suites,
    createdAt: 1,
    reports: suites.map((suiteKind) => ({
      suiteKind,
      status: "completed",
      reportUrl: `${BLOB}?suite=${suiteKind}`,
    })),
  };
}

function storedReport(ids: string[]) {
  return {
    groups: [
      {
        id: "core",
        cases: ids.map((id) => ({
          id,
          title: id,
          category: "wire",
          status: "failed",
          durationMs: 3,
          error: `${id} failed`,
          details: { observed: id },
        })),
      },
    ],
  };
}

function serveBlobs(bySuite: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const suite = new URL(String(input)).searchParams.get("suite") ?? "";
      return new Response(JSON.stringify(bySuite[suite] ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

describe("v1 conformance checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns one check of a run with its stored evidence", async () => {
    convexQueryMock.mockResolvedValue(runRow("completed"));
    serveBlobs({ protocol: storedReport(["wire-schema-valid"]) });
    const res = await request(
      "GET",
      `/api/v1/projects/${PROJECT}/conformance-runs/run_1/checks/wire-schema-valid`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runId: "run_1",
      suiteKind: "protocol",
      id: "wire-schema-valid",
      error: "wire-schema-valid failed",
      details: { observed: "wire-schema-valid" },
      truncated: { details: false, output: false },
    });
  });

  it("answers 404 for a run of another project, an unknown check or a run with no stored report", async () => {
    convexQueryMock.mockResolvedValue({
      ...runRow("completed"),
      projectId: "p2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    });
    serveBlobs({ protocol: storedReport(["ping"]) });
    expect(
      (
        await request(
          "GET",
          `/api/v1/projects/${PROJECT}/conformance-runs/run_1/checks/ping`,
        )
      ).status,
    ).toBe(404);

    convexQueryMock.mockResolvedValue(runRow("completed"));
    expect(
      (
        await request(
          "GET",
          `/api/v1/projects/${PROJECT}/conformance-runs/run_1/checks/nope`,
        )
      ).status,
    ).toBe(404);

    convexQueryMock.mockResolvedValue({ ...runRow("completed"), reports: [] });
    const missing = await request(
      "GET",
      `/api/v1/projects/${PROJECT}/conformance-runs/run_1/checks/ping`,
    );
    expect(missing.status).toBe(404);
    expect(JSON.stringify(await missing.json())).toContain("no stored report");
  });

  it("refuses a suite this surface does not know, and resolves an id two suites share", async () => {
    convexQueryMock.mockResolvedValue(
      runRow("completed", ["protocol", "tasks"]),
    );
    serveBlobs({
      protocol: storedReport(["shared-id"]),
      tasks: storedReport(["shared-id"]),
    });
    const base = `/api/v1/projects/${PROJECT}/conformance-runs/run_1/checks/shared-id`;
    expect((await request("GET", `${base}?suite=events`)).status).toBe(400);
    expect((await request("GET", base)).status).toBe(400);
    const res = await request("GET", `${base}?suite=tasks`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ suiteKind: "tasks" });
  });

  it("pages a finished run's failures through the report's cursor", async () => {
    convexQueryMock.mockResolvedValue(runRow("completed"));
    serveBlobs({
      protocol: storedReport(Array.from({ length: 51 }, (_, i) => `c-${i}`)),
    });
    const path = `/api/v1/projects/${PROJECT}/conformance-runs/run_1/report`;
    const first = (await (await request("GET", path)).json()) as {
      checks: unknown[];
      nextCursor?: string;
    };
    expect(first.checks).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await (
      await request(
        "GET",
        `${path}?cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).json()) as { checks: Array<{ id: string }>; nextCursor?: string };
    expect(second.checks.map((check) => check.id)).toEqual(["c-50"]);
    expect(second.nextCursor).toBeUndefined();
  });
});
