import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp } from "./helpers/test-app.js";

/**
 * GET /api/web/swarm/runs/:runId/stream — WHOSE run is this?
 *
 * The route used to call `assertBearerToken` and nothing else. That proves the
 * caller is *someone*; it says nothing about whether the run is theirs. Run ids
 * are Convex document ids, and they travel — in logs, in shared links, in a
 * screenshot of a URL bar. Any authenticated user holding one could subscribe
 * to another organization's live journey stream, which carries full session
 * transcripts, tool calls and tool results as they happen.
 *
 * `journeyRuns:getJourneyRun` is the authority: it enforces project membership,
 * so someone else's run comes back null exactly like a run that does not exist.
 * Both land on 404, so the route is not an existence oracle either.
 */

const queryMock = vi.fn();
const getRunningJourneyStreamHubMock = vi.fn();

vi.mock("../../../services/evals/route-helpers.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/evals/route-helpers.js")
  >("../../../services/evals/route-helpers.js");
  return {
    ...actual,
    createConvexClient: () => ({ query: queryMock }),
  };
});

vi.mock("../../../utils/v1-convex-token.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/v1-convex-token.js")
  >("../../../utils/v1-convex-token.js");
  return {
    ...actual,
    getConvexBearerForRequest: async () => "convex-jwt",
  };
});

vi.mock("../../../services/sessionSimulation/swarm-runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/sessionSimulation/swarm-runner.js")
  >("../../../services/sessionSimulation/swarm-runner.js");
  return {
    ...actual,
    getRunningJourneyStreamHub: (...args: unknown[]) =>
      getRunningJourneyStreamHubMock(...args),
  };
});

const RUN_ID = "jr_someone_elses_run";

function stream(token: string | null = "test-token-123") {
  const { app } = createWebTestApp();
  return app.request(`/api/web/swarm/runs/${RUN_ID}/stream`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** A hub that would emit if anyone ever got to subscribe to it. */
function liveHub() {
  return { subscribe: vi.fn(() => () => {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRunningJourneyStreamHubMock.mockReturnValue(liveHub());
});

afterEach(() => vi.clearAllMocks());

describe("swarm run stream authorization", () => {
  it("streams a run the caller may read", async () => {
    queryMock.mockResolvedValue({ _id: RUN_ID, projectId: "p1", attempts: [] });

    const res = await stream();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(queryMock).toHaveBeenCalledWith("journeyRuns:getJourneyRun", {
      runId: RUN_ID,
    });
  });

  it("404s a run in someone else's project, and never subscribes to its hub", async () => {
    // What `getJourneyRun` returns when the membership check fails or the run
    // does not exist — the two are indistinguishable by design.
    queryMock.mockResolvedValue(null);

    const res = await stream();
    expect(res.status).toBe(404);
    // The hub is in-process state. Subscribing before the authorization
    // decision would leak every event fired in that window, so the lookup runs
    // FIRST and this assertion is the one that pins the ordering.
    expect(getRunningJourneyStreamHubMock).not.toHaveBeenCalled();
  });

  it("404s — fail CLOSED — when the authorization lookup throws", async () => {
    // Membership rejection, malformed id, or Convex simply unreachable. A live
    // transcript stream is not worth serving on an unverified authorization.
    queryMock.mockRejectedValue(new Error("Not a member of this project"));

    const res = await stream();
    expect(res.status).toBe(404);
    expect(getRunningJourneyStreamHubMock).not.toHaveBeenCalled();
  });

  it("still requires a bearer token at all", async () => {
    const res = await stream(null);
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("checks authorization even for a run with no live hub on this process", async () => {
    // The no-hub branch replies `run_complete` and closes, which is a perfectly
    // good oracle for "this run id is real and running somewhere" if it is
    // reached without a check. It must not be.
    queryMock.mockResolvedValue(null);
    getRunningJourneyStreamHubMock.mockReturnValue(undefined);

    expect((await stream()).status).toBe(404);
  });
});
