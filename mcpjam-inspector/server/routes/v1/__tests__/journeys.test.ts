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

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
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
    // The list is the authoritative answer for "is this journey in this
    // project": Convex returns only the named project's journeys, and the
    // requested id is not among them.
    queryMock.mockResolvedValue([journeyRow({ _id: "jrn_other" })]);

    const res = await get(`/projects/${PROJECT}/journeys/${JOURNEY}/runs`);
    expect(res.status).toBe(404);
    // And it stopped at the preflight — it never asked for the runs.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]?.[0]).toBe("journeys:listJourneysByProject");
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
