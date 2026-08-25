/**
 * `GET /eval-runs/:runId/compare?baseCommitSha=` — the SHA half of the
 * baseline pin (PRD §18.3), end to end through the v1 route.
 *
 * Three things are guarded here, and each has a specific way of silently
 * half-working:
 *
 * 1. **The two selectors are mutually exclusive at the EDGE.** The Convex
 *    action guards too, because it is reachable directly; this route guards so
 *    an HTTP caller learns it without paying for a round trip. Neither may win
 *    silently, so the route's refusal must land before the action is called at
 *    all — asserted by the action mock never running.
 *
 * 2. **The backend's structured refusals keep their message and their 400.**
 *    An unrecognized `ConvexError` code matches none of the translator's
 *    branches, falls past the prose sniffing (which only reads STRING data)
 *    and lands on the terminal 500, where the message is dropped on purpose
 *    and the failure is logged as ours. That is wrong twice for a caller's
 *    malformed input: a 500 for a 400, and a page for a usage error.
 *
 * 3. **A SHA that resolves to NOTHING is not either of those.** It is the
 *    ordinary `baseline_not_found` envelope → 404 + `reason:
 *    BASELINE_NOT_FOUND`, which the CLI maps to exit 3. Exit 3 must keep
 *    meaning "we looked and established nothing", distinct from "you asked for
 *    something impossible" — collapsing them would let a mistyped SHA read as
 *    a comparability finding, or a real usage error read as a clean build.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { convexQueryMock, convexActionMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
  convexActionMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    action: convexActionMock,
    mutation: vi.fn(),
  })),
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
  getConvexBearerThunkForRequest: async () => async () => "convex-jwt",
}));

import v1Routes from "../index.js";
import { v1OnError } from "../envelope.js";

const RUN_ID = "run_compare";
const BASE = `/api/v1/projects/p1/eval-runs/${RUN_ID}/compare`;
const SHA = "9f1a2b3c4d5e6f70819293a4b5c6d7e8f9a0b1c2";

function makeApp(): Hono {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", v1Routes);
  return app;
}

function get(path: string): Promise<Response> {
  return makeApp().request(path, {
    method: "GET",
    headers: { Authorization: "Bearer tok" },
  });
}

/** The compare run the route reads BEFORE it calls the action. */
const RUN_DOC = { _id: RUN_ID, projectId: "p1", suiteId: "suite_1" };

/** A minimal diff — these tests assert the baseline envelope, not the diff. */
const DIFF = {
  suite: { id: "suite_1", name: "Suite" },
  baseRun: { id: "run_base" },
  compareRun: { id: RUN_ID },
  scores: {},
  metrics: {},
  cases: [],
};

/** A ConvexError as the production error mask actually delivers it. */
function convexError(code: string, message: string): Error {
  return Object.assign(new Error("[CONVEX] masked"), {
    data: { code, message },
  });
}

describe("compare route: baseCommitSha", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    convexQueryMock.mockResolvedValue(RUN_DOC);
  });

  it("forwards the SHA under the BACKEND's own argument name", async () => {
    convexActionMock.mockResolvedValue({
      status: "ok",
      diff: DIFF,
      baseline: {
        policy: "commit_sha",
        baseRunId: "run_base",
        baseCommitSha: SHA,
      },
    });

    const res = await get(`${BASE}?baseCommitSha=${SHA}`);
    expect(res.status).toBe(200);

    // `baseCommitSha`, not a synonym: the wire, the route and the Convex call
    // all have to read the same or a rename breaks one of the three silently.
    const args = convexActionMock.mock.calls[0][1];
    expect(args.baseCommitSha).toBe(SHA);
    expect(args.baseRunId).toBeUndefined();

    const body = (await res.json()) as any;
    expect(body.baseline.policy).toBe("commit_sha");
    expect(body.baseline.baseRunId).toBe("run_base");
    expect(body.baseline.baseCommitSha).toBe(SHA);
    // Absent means UNAMBIGUOUS. Publishing a 1 here would invent a uniqueness
    // claim the backend never made.
    expect(body.baseline.matchCount).toBeUndefined();
    expect(body.baseline.matchCountTruncated).toBeUndefined();
  });

  it("trims the SHA before it reaches the wire", async () => {
    convexActionMock.mockResolvedValue({
      status: "ok",
      diff: DIFF,
      baseline: { policy: "commit_sha", baseRunId: "run_base" },
    });
    const padded = encodeURIComponent(` ${SHA} `);
    const res = await get(`${BASE}?baseCommitSha=${padded}`);
    expect(res.status).toBe(200);
    expect(convexActionMock.mock.calls[0][1].baseCommitSha).toBe(SHA);
  });

  it("surfaces an AMBIGUOUS match with its count", async () => {
    convexActionMock.mockResolvedValue({
      status: "ok",
      diff: DIFF,
      baseline: {
        policy: "commit_sha",
        baseRunId: "run_base",
        baseCommitSha: SHA,
        matchCount: 3,
      },
    });
    const res = await get(`${BASE}?baseCommitSha=${SHA}`);
    const body = (await res.json()) as any;
    expect(body.baseline.matchCount).toBe(3);
  });

  it("surfaces matchCountTruncated ALONGSIDE its count, including at 1", async () => {
    // The case that makes the flag load-bearing: a count of 1 that is a FLOOR.
    // Rendering the 1 without the flag asserts a uniqueness nobody checked —
    // and a regression verdict rests on exactly that claim.
    convexActionMock.mockResolvedValue({
      status: "ok",
      diff: DIFF,
      baseline: {
        policy: "commit_sha",
        baseRunId: "run_base",
        baseCommitSha: SHA,
        matchCount: 1,
        matchCountTruncated: true,
      },
    });
    const res = await get(`${BASE}?baseCommitSha=${SHA}`);
    const body = (await res.json()) as any;
    expect(body.baseline.matchCount).toBe(1);
    expect(body.baseline.matchCountTruncated).toBe(true);
  });

  it("never publishes a truncation flag without the count it qualifies", async () => {
    convexActionMock.mockResolvedValue({
      status: "ok",
      diff: DIFF,
      baseline: {
        policy: "commit_sha",
        baseRunId: "run_base",
        // No matchCount: the backend established uniqueness. A stray flag must
        // not travel alone — on its own it says nothing a reader can act on.
        matchCountTruncated: true,
      },
    });
    const res = await get(`${BASE}?baseCommitSha=${SHA}`);
    const body = (await res.json()) as any;
    expect(body.baseline.matchCount).toBeUndefined();
    expect(body.baseline.matchCountTruncated).toBeUndefined();
  });

  it("refuses both selectors at the EDGE, without calling the action", async () => {
    const res = await get(`${BASE}?baseRunId=run_x&baseCommitSha=${SHA}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toMatch(/not both/i);
    // The point of the edge guard: no round trip was spent to learn this.
    expect(convexActionMock).not.toHaveBeenCalled();
  });

  it("refuses a blank SHA at the edge", async () => {
    const res = await get(`${BASE}?baseCommitSha=${encodeURIComponent("   ")}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("VALIDATION_ERROR");
    expect(convexActionMock).not.toHaveBeenCalled();
  });

  it("maps EVAL_COMPARE_BASELINE_CONFLICT to 400, message preserved", async () => {
    const message = "Pass baseRunId or baseCommitSha, not both.";
    convexActionMock.mockRejectedValue(
      convexError("EVAL_COMPARE_BASELINE_CONFLICT", message),
    );
    // Reached via the action, not the edge guard: only one selector is on the
    // query string, so this is the backend's own refusal being translated.
    const res = await get(`${BASE}?baseCommitSha=${SHA}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("VALIDATION_ERROR");
    // The BACKEND's message, not the generic fallback and not a 500.
    expect(body.message).toBe(message);
  });

  it("maps EVAL_COMPARE_BASELINE_INVALID to 400, message preserved", async () => {
    const message = "baseCommitSha must not be blank.";
    convexActionMock.mockRejectedValue(
      convexError("EVAL_COMPARE_BASELINE_INVALID", message),
    );
    const res = await get(`${BASE}?baseCommitSha=${SHA}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toBe(message);
  });

  it("an UNRESOLVABLE SHA is baseline_not_found (404), NOT a 400", async () => {
    convexActionMock.mockResolvedValue({ status: "baseline_not_found" });
    const res = await get(`${BASE}?baseCommitSha=${SHA}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    // The machine field the CLI keys on for exit 3.
    expect(body.details.reason).toBe("BASELINE_NOT_FOUND");
    // Which commit found nothing — an archived CI log needs to say.
    expect(body.details.baseCommitSha).toBe(SHA);
    expect(body.message).toMatch(/commit SHA/i);
  });
});
