import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The Swarms authoring + insights surface (`personas.ts`, `swarms.ts`, the
 * authoring half of `journeys.ts`, `swarm-insights.ts`).
 *
 * What these pin, in order of how badly they would fail silently:
 *
 *   1. CROSS-PROJECT SCOPING. Every by-id Convex function on this surface
 *      takes the resource id ALONE and checks membership of whatever project
 *      the row turns out to be in — never the project named in the path. A
 *      caller who is a member of both A and B could otherwise edit B's persona
 *      through A's URL. The answer is 404, never 403, so the route is not an
 *      existence oracle for a project the caller cannot see.
 *   2. IDEMPOTENCY KEY PASSTHROUGH, UNTRANSFORMED. The backend fingerprints a
 *      replay as sha256 of the mutation args minus the key. If this layer
 *      injected a value or defaulted a field differently between the original
 *      and the retry, the retry would arrive with a different fingerprint and
 *      be rejected as key REUSE rather than honoured as a retry.
 *   3. FEATURE_UNAVAILABLE mapping distinctly to 403. The default FORBIDDEN
 *      mapping is 404, which would tell a flagged-off customer their project
 *      does not exist.
 */

const { queryMock, mutationMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
  getConvexBearerThunkForRequest: () => async () => "convex-jwt",
}));

import journeys from "../journeys.js";
import personas from "../personas.js";
import swarms from "../swarms.js";
import swarmInsights from "../swarm-insights.js";
import { v1OnError } from "../envelope.js";

const PROJECT = "proj_a";
const OTHER_PROJECT = "proj_b";

function makeApp(...routers: Array<Parameters<Hono["route"]>[1]>) {
  const app = new Hono();
  app.onError(v1OnError);
  for (const router of routers) app.route("/api/v1", router);
  return app;
}

function call(
  router: Parameters<Hono["route"]>[1],
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {}
) {
  return makeApp(router).request(`/api/v1${path}`, {
    method,
    ...(init.body !== undefined
      ? {
          body: JSON.stringify(init.body),
          headers: { "content-type": "application/json", ...init.headers },
        }
      : { headers: init.headers ?? {} }),
  });
}

const personaRow = (overrides: Record<string, unknown> = {}) => ({
  _id: "persona_1",
  personaId: "impatient-buyer",
  name: "Ada",
  role: "buyer",
  notes: "Impatient.",
  source: "manual",
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

/** A ConvexError as the client surfaces it: `.data` carries the structure. */
function convexError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code, message } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.test");
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("persona routes", () => {
  it("lists the project's personas under the public DTO", async () => {
    queryMock.mockResolvedValue([personaRow()]);
    const res = await call(personas, "GET", `/projects/${PROJECT}/personas`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    // `id` is the DURABLE row id — what journeys reference. The slug-shaped
    // external key is `slug`; returning that as `id` would mean a caller who
    // listed personas could not then create a journey against one.
    expect(body.items[0]).toMatchObject({
      id: "persona_1",
      slug: "impatient-buyer",
      projectId: PROJECT,
      name: "Ada",
    });
  });

  it("404s a persona from ANOTHER project rather than editing it", async () => {
    // `personas:updatePersona` takes a personaRefId alone. Without the
    // list-and-scan preflight this would edit project B's persona under a URL
    // that says A.
    queryMock.mockResolvedValue([personaRow({ _id: "persona_in_a" })]);
    const res = await call(
      personas,
      "PATCH",
      `/projects/${PROJECT}/personas/persona_in_b`,
      { body: { name: "Renamed" } }
    );
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("forwards the idempotency-key header VERBATIM as the Convex arg", async () => {
    queryMock.mockResolvedValue([]);
    mutationMock.mockResolvedValue(personaRow());
    await call(personas, "POST", `/projects/${PROJECT}/personas`, {
      body: { name: "Ada", role: "buyer" },
      headers: { "idempotency-key": "key-123" },
    });
    const [, args] = mutationMock.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(args.idempotencyKey).toBe("key-123");
  });

  it("sends IDENTICAL args on a replay, or the fingerprint check rejects it", async () => {
    // The backend hashes the args minus the key. Two calls with the same body
    // must produce byte-identical arg objects — a timestamp, a default filled
    // in on one path only, or a renamed field would turn a legitimate retry
    // into a key-reuse rejection.
    queryMock.mockResolvedValue([]);
    mutationMock.mockResolvedValue(personaRow());
    const body = { name: "Ada", role: "buyer", notes: "Impatient." };
    const headers = { "idempotency-key": "key-123" };
    await call(personas, "POST", `/projects/${PROJECT}/personas`, {
      body,
      headers,
    });
    await call(personas, "POST", `/projects/${PROJECT}/personas`, {
      body,
      headers,
    });
    const [, first] = mutationMock.mock.calls[0] as [string, unknown];
    const [, second] = mutationMock.mock.calls[1] as [string, unknown];
    expect(second).toEqual(first);
  });

  it("omits an absent idempotency key rather than minting one", async () => {
    // A server-minted key would make every call look retryable and dedupe
    // requests the caller meant as separate.
    queryMock.mockResolvedValue([]);
    mutationMock.mockResolvedValue(personaRow());
    await call(personas, "POST", `/projects/${PROJECT}/personas`, {
      body: { name: "Ada", role: "buyer" },
    });
    const [, args] = mutationMock.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(args).not.toHaveProperty("idempotencyKey");
  });

  it("maps the beta gate's FEATURE_UNAVAILABLE onto 403, not 404", async () => {
    queryMock.mockResolvedValue([]);
    mutationMock.mockRejectedValue(
      convexError(
        "FEATURE_UNAVAILABLE",
        "Swarms is not currently available for your organization"
      )
    );
    const res = await call(personas, "POST", `/projects/${PROJECT}/personas`, {
      body: { name: "Ada", role: "buyer" },
    });
    // A 404 here would tell a flagged-off customer their project is gone, and
    // they would go looking for a project that is fine.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/not currently available/i);
  });

  it("rejects an empty update rather than issuing a no-op mutation", async () => {
    queryMock.mockResolvedValue([personaRow()]);
    const res = await call(
      personas,
      "PATCH",
      `/projects/${PROJECT}/personas/persona_1`,
      { body: {} }
    );
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe("journey authoring", () => {
  it("404s a persona from ANOTHER project instead of running it", async () => {
    // `journeys:createJourney` resolves `personaRefId` on its own and checks
    // membership of whatever project it lives in — so without the preflight a
    // member of both could author a journey in A that runs B's persona.
    queryMock.mockResolvedValue([personaRow({ _id: "persona_in_a" })]);
    const res = await call(journeys, "POST", `/projects/${PROJECT}/journeys`, {
      body: {
        goal: "buy a thing",
        personaId: "persona_in_b",
        sessionsPerTarget: 1,
        maxTurns: 8,
      },
    });
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("404s a swarm container from another project", async () => {
    queryMock.mockImplementation((name: string) =>
      Promise.resolve(
        String(name).includes("listPersonas")
          ? [personaRow()]
          : { _id: "swarm_1", projectId: OTHER_PROJECT }
      )
    );
    const res = await call(journeys, "POST", `/projects/${PROJECT}/journeys`, {
      body: {
        goal: "buy a thing",
        personaId: "persona_1",
        swarmId: "swarm_in_b",
        sessionsPerTarget: 1,
        maxTurns: 8,
      },
    });
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe("swarm container routes", () => {
  const swarmRow = (projectId = PROJECT) => ({
    _id: "swarm_1",
    projectId,
    name: "Checkout",
    description: null,
    environmentIds: ["env_1"],
    config: { sessionsPerTarget: 2, maxTurns: 8 },
    createdAt: 1,
    updatedAt: 2,
  });

  it("404s a swarm that resolves into another project", async () => {
    queryMock.mockResolvedValue(swarmRow(OTHER_PROJECT));
    const res = await call(
      swarms,
      "GET",
      `/projects/${PROJECT}/swarms/swarm_1`
    );
    expect(res.status).toBe(404);
  });

  it("wraps the loose config fields into the nested Convex object", async () => {
    mutationMock.mockResolvedValue(swarmRow());
    await call(swarms, "POST", `/projects/${PROJECT}/swarms`, {
      body: { name: "Checkout", sessionsPerTarget: 2, maxTurns: 8 },
    });
    const [, args] = mutationMock.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(args.config).toEqual({ sessionsPerTarget: 2, maxTurns: 8 });
  });

  it("refuses a half-config update instead of read-modify-writing it", async () => {
    // `config` is one object upstream. Patching half would need a read, and a
    // concurrent edit between the read and the write would be lost silently.
    queryMock.mockResolvedValue(swarmRow());
    const res = await call(
      swarms,
      "PATCH",
      `/projects/${PROJECT}/swarms/swarm_1`,
      { body: { sessionsPerTarget: 5 } }
    );
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("forwards an explicit null so a caller can CLEAR the fan-out", async () => {
    queryMock.mockResolvedValue(swarmRow());
    mutationMock.mockResolvedValue(swarmRow());
    await call(swarms, "PATCH", `/projects/${PROJECT}/swarms/swarm_1`, {
      body: { environmentIds: null },
    });
    const [, args] = mutationMock.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    // Collapsing null to undefined would turn "stop using environments" into
    // "change nothing", which is the failure the tri-state exists to prevent.
    expect(args.environmentIds).toBeNull();
  });
});

describe("swarm insights routes", () => {
  it("404s a scorecard for a run in another project", async () => {
    queryMock.mockResolvedValue({ projectId: OTHER_PROJECT });
    const res = await call(
      swarmInsights,
      "GET",
      `/projects/${PROJECT}/journey-runs/run_1/scorecard`
    );
    expect(res.status).toBe(404);
  });

  it("distinguishes 'no rubric' from an empty scorecard", async () => {
    // An empty criteria list would claim a rubric that graded nothing, which
    // is a different and misleading statement from "this run has no rubric".
    queryMock
      .mockResolvedValueOnce({ projectId: PROJECT })
      .mockResolvedValueOnce(null);
    const res = await call(
      swarmInsights,
      "GET",
      `/projects/${PROJECT}/journey-runs/run_1/scorecard`
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/no rubric/i);
  });

  it("keeps failed grading apart from failures in the DTO", async () => {
    queryMock
      .mockResolvedValueOnce({ projectId: PROJECT })
      .mockResolvedValueOnce({
        criteria: [
          {
            criterionId: "c1",
            kind: "contains",
            passCount: 1,
            failCount: 2,
            pendingCount: 3,
            failedGradingCount: 4,
          },
        ],
        sessionsTotal: 10,
        sessionsGraded: 3,
      });
    const res = await call(
      swarmInsights,
      "GET",
      `/projects/${PROJECT}/journey-runs/run_1/scorecard`
    );
    const body = (await res.json()) as {
      criteria: Array<Record<string, number>>;
    };
    // Folding these together would make a crashed judge read as a product
    // regression, and someone would act on it.
    expect(body.criteria[0]).toMatchObject({
      failCount: 2,
      pendingCount: 3,
      failedGradingCount: 4,
    });
  });

  it("renames swarmRunGroupId to waveId across the overview", async () => {
    queryMock.mockResolvedValue({
      runs: [
        {
          runId: "run_1",
          journeyRefId: "j_1",
          journeyName: "Checkout",
          journeyArchived: false,
          personaName: "Ada",
          createdAt: 1,
          swarmRunGroupId: "wave_1",
          status: "completed",
          summary: { total: 1, succeeded: 1, failed: 0, rateLimited: 0 },
          findings: [],
          targets: [],
        },
      ],
      runsConsidered: 1,
      goalCompletion: {
        gradedCount: 0,
        passedCount: 0,
        passRate: null,
        runsWithGrades: 0,
        trend: [],
      },
    });
    const res = await call(
      swarmInsights,
      "GET",
      `/projects/${PROJECT}/journeys-overview`
    );
    const body = (await res.json()) as {
      runs: Array<Record<string, unknown>>;
      goalCompletion: { passRate: number | null };
    };
    expect(body.runs[0]).toMatchObject({ waveId: "wave_1" });
    expect(body.runs[0]).not.toHaveProperty("swarmRunGroupId");
    // `null`, not 0: nothing graded is not the same claim as everything failed.
    expect(body.goalCompletion.passRate).toBeNull();
  });

  it("answers 202 for a wave-insights request, because it is scheduled", async () => {
    mutationMock.mockResolvedValue(null);
    const res = await call(
      swarmInsights,
      "POST",
      `/projects/${PROJECT}/waves/wave_1/insights`
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      waveId: "wave_1",
      status: "pending",
    });
  });

  it("maps the daily insights cap onto 429, distinct from the beta gate", async () => {
    // A caller told FEATURE_UNAVAILABLE would go and ask for a plan they
    // already have; a caller told RATE_LIMITED knows to wait.
    mutationMock.mockRejectedValue(
      convexError(
        "billing_limit_reached",
        'Limit "insightsPerDay" reached on the free plan.'
      )
    );
    const res = await call(
      swarmInsights,
      "POST",
      `/projects/${PROJECT}/waves/wave_1/insights`
    );
    expect(res.status).toBe(429);
  });

  it("404s wave insights nobody has requested", async () => {
    // Distinct from `pending`: a caller polling in a loop must be able to tell
    // "nobody asked for this" from "asked and still working".
    queryMock.mockResolvedValue(null);
    const res = await call(
      swarmInsights,
      "GET",
      `/projects/${PROJECT}/waves/wave_1/insights`
    );
    expect(res.status).toBe(404);
  });

  it("404s a finding that belongs to another project", async () => {
    queryMock.mockResolvedValue([
      { findingId: "finding_in_a", fingerprint: "f", dimension: "d" },
    ]);
    const res = await call(
      swarmInsights,
      "POST",
      `/projects/${PROJECT}/journey-findings/finding_in_b/dismiss`
    );
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});
