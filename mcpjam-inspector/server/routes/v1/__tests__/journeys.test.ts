import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The v1 journey surface (`server/routes/v1/journeys.ts`).
 *
 * What these pin, in order of how badly a regression would hurt:
 *
 *   1. CROSS-PROJECT SCOPING, which this route enforces and Convex does NOT.
 *      `journeyRuns:listJourneyRuns` takes a journeyRefId alone and
 *      `getJourneyRun` takes a runId alone — both check membership, neither
 *      checks the project in the path. Without the preflights,
 *      `GET /projects/A/journeys/{a-journey-in-B}/runs` serves project B's
 *      runs to anyone who is a member of both.
 *   2. The `canceled` mapping. The backend records a deliberate stop as
 *      `status: "failed"` plus an `error: "canceled"` marker rather than a new
 *      status literal, so a client reading `status` alone renders every
 *      cancellation as a failure.
 *   3. Cursor mapping. Convex returns a non-empty `continueCursor` even on the
 *      last page; forwarding it unconditionally makes a client loop forever
 *      fetching empty pages.
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

vi.mock("../../../services/xaa-mint.js", () => ({
  resolveXaaIssuer: () => "https://issuer.test",
}));

vi.mock("../../web/auth.js", () => ({
  callerContextFromHono: () => ({}),
}));

const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));
vi.mock("../../../services/sessionSimulation/launch-journey-run.js", () => ({
  launchJourneyRun: (...args: unknown[]) => launchMock(...args),
}));

import journeys from "../journeys.js";
import { v1OnError } from "../envelope.js";

const PROJECT = "proj_a";
const OTHER_PROJECT = "proj_b";
const JOURNEY = "jrn_1";
const RUN = "run_1";

function makeApp() {
  const app = new Hono();
  // Mirror the real mount: the v1 index installs this, and it is what turns a
  // WebRouteError into the canonical `{ code, message }` envelope. Without it
  // every deliberate 404 here would surface as an unhandled 500.
  app.onError(v1OnError);
  app.route("/api/v1", journeys);
  return app;
}

function get(path: string) {
  return makeApp().request(`/api/v1${path}`);
}

const journeyRow = (overrides: Record<string, unknown> = {}) => ({
  _id: JOURNEY,
  projectId: PROJECT,
  personaRefId: "persona_1",
  swarmRefId: null,
  name: "Checkout flow",
  goal: "Buy something",
  serverAttachmentId: null,
  environmentIds: ["env_1"],
  config: { sessionsPerTarget: 3, maxTurns: 12 },
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const runRow = (overrides: Record<string, unknown> = {}) => ({
  _id: RUN,
  projectId: PROJECT,
  journeyRefId: JOURNEY,
  status: "running",
  summary: { total: 3, succeeded: 1, failed: 0, rateLimited: 0 },
  snapshot: { hosts: [{ hostId: "h1", hostName: "Host 1", targetId: "t1" }] },
  createdAt: 10,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  // The route builds its own Convex client; without a URL it fails closed with
  // a 500 before any of the logic under test runs.
  vi.stubEnv("CONVEX_URL", "https://convex.test");
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /projects/:projectId/journeys", () => {
  it("returns the project's journeys as a page", async () => {
    queryMock.mockResolvedValue([journeyRow()]);

    const res = await get(`/projects/${PROJECT}/journeys`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: JOURNEY,
      name: "Checkout flow",
      goal: "Buy something",
      personaId: "persona_1",
      sessionsPerTarget: 3,
      maxTurns: 12,
    });
  });

  it("404s rather than 502s when Convex rejects for membership", async () => {
    // A 403 here would confirm the project exists to someone who cannot see it.
    queryMock.mockRejectedValue(new Error("Not a member of this project"));
    expect((await get(`/projects/${PROJECT}/journeys`)).status).toBe(404);
  });
});

describe("cross-project scoping", () => {
  it("404s a journey that belongs to ANOTHER project the caller can also see", async () => {
    // `journeys:getJourney` takes BOTH ids and asserts the scope itself, so a
    // journey outside the project reads as `null` — the same answer as one
    // that does not exist. This used to list the project and scan, which put
    // the scope rule in the gateway; it lives in Convex now.
    queryMock.mockResolvedValue(null);

    const res = await get(`/projects/${PROJECT}/journeys/${JOURNEY}/runs`);
    expect(res.status).toBe(404);
    // And it stopped at the preflight — it never asked for the runs.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]?.[0]).toBe("journeys:getJourney");
    // Scoped by BOTH ids. Dropping `projectId` would still return null from
    // this mock and still 404 here, while in production it would resolve a
    // journey from any project the caller can reach.
    expect(queryMock.mock.calls[0]?.[1]).toEqual({
      projectId: PROJECT,
      journeyRefId: JOURNEY,
    });
  });

  it("404s a run whose projectId disagrees with the path", async () => {
    queryMock.mockResolvedValue(runRow({ projectId: OTHER_PROJECT }));
    expect((await get(`/projects/${PROJECT}/journey-runs/${RUN}`)).status).toBe(
      404
    );
  });

  it("checks the run's project before listing its sessions", async () => {
    queryMock.mockResolvedValueOnce(runRow({ projectId: OTHER_PROJECT }));
    const res = await get(`/projects/${PROJECT}/journey-runs/${RUN}/sessions`);
    expect(res.status).toBe(404);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("run DTO", () => {
  it("surfaces a CANCELED run as canceled, not merely failed", async () => {
    queryMock.mockResolvedValue(
      runRow({ status: "failed", error: "canceled" })
    );

    const res = await get(`/projects/${PROJECT}/journey-runs/${RUN}`);
    const body = (await res.json()) as Record<string, unknown>;
    // Both are true, and both matter: the status is honest about the terminal
    // state, the flag is honest about why.
    expect(body).toMatchObject({
      status: "failed",
      canceled: true,
      stale: false,
    });
  });

  it("surfaces a STALE-runner run distinctly too", async () => {
    queryMock.mockResolvedValue(
      runRow({ status: "failed", error: "stale_runner" })
    );
    const body = (await (
      await get(`/projects/${PROJECT}/journey-runs/${RUN}`)
    ).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ canceled: false, stale: true });
  });

  it("renames swarmRunGroupId to waveId and exposes targets", async () => {
    queryMock.mockResolvedValue(runRow({ swarmRunGroupId: "wave_7" }));
    const body = (await (
      await get(`/projects/${PROJECT}/journey-runs/${RUN}`)
    ).json()) as Record<string, unknown>;
    expect(body.waveId).toBe("wave_7");
    expect(body).not.toHaveProperty("swarmRunGroupId");
    expect(body.targets).toEqual([
      { hostId: "h1", hostName: "Host 1", targetId: "t1" },
    ]);
  });
});

describe("pagination", () => {
  it("sends a null cursor on the first page and the caller's cursor after", async () => {
    queryMock
      .mockResolvedValueOnce([journeyRow()])
      .mockResolvedValueOnce({ page: [], isDone: true, continueCursor: "" });
    await get(`/projects/${PROJECT}/journeys/${JOURNEY}/runs`);
    // Convex requires an explicit null, not an absent field, for page one.
    expect(queryMock.mock.calls[1]?.[1]).toMatchObject({
      paginationOpts: { cursor: null, numItems: 50 },
    });

    vi.clearAllMocks();
    queryMock
      .mockResolvedValueOnce([journeyRow()])
      .mockResolvedValueOnce({ page: [], isDone: true, continueCursor: "" });
    await get(
      `/projects/${PROJECT}/journeys/${JOURNEY}/runs?cursor=abc&limit=10`
    );
    expect(queryMock.mock.calls[1]?.[1]).toMatchObject({
      paginationOpts: { cursor: "abc", numItems: 10 },
    });
  });

  it("caps an oversized limit instead of forwarding it", async () => {
    queryMock
      .mockResolvedValueOnce([journeyRow()])
      .mockResolvedValueOnce({ page: [], isDone: true, continueCursor: "" });
    await get(`/projects/${PROJECT}/journeys/${JOURNEY}/runs?limit=100000`);
    expect(queryMock.mock.calls[1]?.[1]).toMatchObject({
      paginationOpts: { numItems: 200 },
    });
  });

  it("OMITS nextCursor on the last page, even though Convex still sends one", async () => {
    queryMock.mockResolvedValueOnce([journeyRow()]).mockResolvedValueOnce({
      page: [runRow()],
      isDone: true,
      // Non-empty on the final page. Forwarding this makes a client loop.
      continueCursor: "cursor-that-would-loop",
    });
    const body = (await (
      await get(`/projects/${PROJECT}/journeys/${JOURNEY}/runs`)
    ).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("nextCursor");
  });

  it("forwards nextCursor when more pages remain", async () => {
    queryMock.mockResolvedValueOnce([journeyRow()]).mockResolvedValueOnce({
      page: [runRow()],
      isDone: false,
      continueCursor: "page2",
    });
    const body = (await (
      await get(`/projects/${PROJECT}/journeys/${JOURNEY}/runs`)
    ).json()) as Record<string, unknown>;
    expect(body.nextCursor).toBe("page2");
  });
});

describe("POST .../journey-runs/:runId/cancel", () => {
  const cancelUrl = `/projects/${PROJECT}/journey-runs/${RUN}/cancel`;

  function cancel() {
    return makeApp().request(`/api/v1${cancelUrl}`, { method: "POST" });
  }

  /** A ConvexError as the client surfaces it: `.data` carries the structure. */
  function convexError(code: string, message: string) {
    return Object.assign(new Error(message), { data: { code, message } });
  }

  it("stops a running run", async () => {
    queryMock.mockResolvedValueOnce(runRow());
    mutationMock.mockResolvedValue({
      runId: RUN,
      status: "failed",
      canceled: true,
      alreadyCanceled: false,
      finalized: 3,
    });

    const res = await cancel();
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      id: RUN,
      canceled: true,
      alreadyCanceled: false,
      finalized: 3,
    });
  });

  it("is idempotent — a re-cancel is success, not a conflict", async () => {
    // A canceled run is no longer `running`, so a naive implementation would
    // 409 every retry of a dropped response.
    queryMock.mockResolvedValueOnce(runRow({ error: "canceled" }));
    mutationMock.mockResolvedValue({
      runId: RUN,
      status: "failed",
      canceled: true,
      alreadyCanceled: true,
      finalized: 0,
    });

    const res = await cancel();
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      alreadyCanceled: true,
      finalized: 0,
    });
  });

  it("409s a run that already finished on its own", async () => {
    // Distinct from the idempotent case on purpose: "you cannot stop something
    // that completed" is a different answer from "that was already stopped",
    // and a script retrying blindly should be able to tell them apart.
    queryMock.mockResolvedValueOnce(runRow({ status: "completed" }));
    mutationMock.mockRejectedValue(
      convexError(
        "CONFLICT",
        "Run already completed; only a running run can be canceled."
      )
    );

    expect((await cancel()).status).toBe(409);
  });

  it("404s a run in another project, without calling the mutation", async () => {
    queryMock.mockResolvedValueOnce(runRow({ projectId: OTHER_PROJECT }));
    expect((await cancel()).status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

/**
 * `POST /projects/:p/journeys/:journeyId/runs`.
 *
 * The launch is the one operation here that SPENDS, so the two things worth
 * pinning are that it cannot be aimed at another project's journey, and that
 * a retry cannot bill twice.
 */
describe("POST .../journeys/:journeyId/runs", () => {
  beforeEach(() => {
    launchMock.mockResolvedValue({ runId: "run_new" });
    // `journeys:getJourney` returns the ROW or null; the default is "this
    // journey IS in this project" so each case overrides only the one thing it
    // is about.
    queryMock.mockResolvedValue({ _id: JOURNEY, projectId: PROJECT });
  });

  const launch = (init: RequestInit = {}) =>
    makeApp().request(`/api/v1/projects/${PROJECT}/journeys/${JOURNEY}/runs`, {
      method: "POST",
      ...init,
    });

  it("202s with the run id, and accepts NO body at all", async () => {
    // The common case is a bodyless POST. `c.req.json()` throws on an empty
    // payload, so a naive handler turns the simplest possible call into a 400.
    const res = await launch();
    expect(res.status).toBe(202);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      id: "run_new",
      journeyId: JOURNEY,
      projectId: PROJECT,
      status: "running",
      deduped: false,
    });
  });

  it("forwards the idempotency-key header as the launch key", async () => {
    await launch({ headers: { "idempotency-key": "key-123" } });
    expect(launchMock.mock.calls[0]![1]).toMatchObject({
      launchKey: "key-123",
    });
  });

  it("mints a launch key when the caller sends none", async () => {
    // A caller that declined to identify its retry gets a fresh run — the
    // honest reading. What must NOT happen is a fixed key, which would make
    // two unrelated launches collapse into one.
    await launch();
    const first = (launchMock.mock.calls[0]![1] as { launchKey: string })
      .launchKey;
    await launch();
    const second = (launchMock.mock.calls[1]![1] as { launchKey: string })
      .launchKey;
    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("reports deduped when a replayed key landed on an existing run", async () => {
    launchMock.mockResolvedValue({ runId: "run_orig", deduped: true });
    const res = await launch({ headers: { "idempotency-key": "key-123" } });
    expect(res.status).toBe(202);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      id: "run_orig",
      deduped: true,
    });
  });

  it("404s a journey in ANOTHER project — WITHOUT launching", async () => {
    // The launch resolves the project from the journey itself, so without the
    // preflight a member of two projects could launch B's journey through A's
    // URL and be billed under a project the URL never named.
    // Convex answers `null` for a journey outside the project — the same
    // answer as one that does not exist, which is what keeps this from being
    // an existence oracle.
    queryMock.mockResolvedValue(null);
    expect((await launch()).status).toBe(404);
    expect(launchMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith("journeys:getJourney", {
      projectId: PROJECT,
      journeyRefId: JOURNEY,
    });
  });

  it("surfaces the beta gate as 403 with its real message", async () => {
    launchMock.mockRejectedValue(
      Object.assign(new Error("Swarms is not currently available."), {
        data: {
          code: "FEATURE_UNAVAILABLE",
          message: "Swarms is not currently available.",
        },
      })
    );
    const res = await launch();
    expect(res.status).toBe(403);
    expect((await res.json()) as { message?: string }).toMatchObject({
      message: "Swarms is not currently available.",
    });
  });

  it("forwards the fan-out options — the whole point of accepting a body", async () => {
    const res = await launch({
      body: JSON.stringify({
        waveId: "wave_9",
        environmentIds: ["env_1", "env_2"],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(202);
    expect(launchMock.mock.calls[0]![1]).toMatchObject({
      waveId: "wave_9",
      environmentIds: ["env_1", "env_2"],
    });
  });

  it("400s an EMPTY environmentIds rather than falling back to the authored targets", async () => {
    // `[]` is a caller naming no environments, which is not the same request
    // as omitting the field. Dropping it and launching as authored would run
    // something other than what was asked for — on an operation that spends.
    const res = await launch({
      body: JSON.stringify({ environmentIds: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("400s a NULL body — that is a broken client, not an empty one", async () => {
    const res = await launch({
      body: "null",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("400s an out-of-shape option", async () => {
    const res = await launch({
      body: JSON.stringify({ environmentIds: "env_1" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed body rather than launching on a guess", async () => {
    const res = await launch({
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(launchMock).not.toHaveBeenCalled();
  });
});
