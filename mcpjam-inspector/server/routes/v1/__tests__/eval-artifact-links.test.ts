import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * MJ-005 — the public eval iteration reads (`/steps` and `/trace`) carry
 * screenshot and recording links only as signed `/web/artifact` links. A
 * value of any other shape from the backend reads as absent.
 */

const { validateGuestTokenMock, convexQueryMock, convexActionMock, fetchMock } =
  vi.hoisted(() => ({
    validateGuestTokenMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexActionMock: vi.fn(),
    fetchMock: vi.fn(),
  }));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: vi.fn(),
    action: convexActionMock,
  })),
}));

import v1Routes from "../index.js";

const PROJECT_ID = "p1";
const RUN_ID = "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const ITERATION_ID = "iter1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const CONVEX_HTTP_URL = "https://example.convex.site";

const SIGNED_SHOT = `${CONVEX_HTTP_URL}/web/artifact?t=c2hvdA.c2ln`;
const SIGNED_VIDEO = `${CONVEX_HTTP_URL}/web/artifact?t=dmlkZW8.c2ln`;
const STORAGE_SHOT =
  "https://example.convex.cloud/api/storage/11111111-2222-4333-8444-555555555555";
const STORAGE_VIDEO =
  "https://example.convex.cloud/api/storage/66666666-7777-4888-9999-000000000000";

const RUN_DOC = {
  _id: RUN_ID,
  projectId: PROJECT_ID,
  suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
  runNumber: 1,
  status: "completed",
  result: "passed",
  createdAt: 1,
};

const ITERATION_DOC = {
  _id: ITERATION_ID,
  suiteRunId: RUN_ID,
  testCaseSnapshot: {
    title: "a case",
    steps: [{ id: "s1", kind: "prompt", prompt: "open the cart" }],
  },
  metadata: {
    stepResults: [{ stepId: "s1", stepIndex: 0, kind: "prompt", status: "ok" }],
  },
  status: "completed",
  result: "passed",
};

function traceEnvelope(links: { shot: string; video: string }) {
  return {
    traceVersion: 1,
    messages: [{ role: "user", content: "open the cart" }],
    browserInteractionSteps: [
      {
        toolCallId: "tc-1",
        stepIndex: 0,
        promptIndex: 0,
        action: "left_click",
        authoredStepId: "s1",
        videoOffsetMs: 1_500,
        source: "scripted",
        screenshotUrl: links.shot,
      },
    ],
    videoUrl: links.video,
    videoMeta: { durationMs: 4_000 },
  };
}

async function read(kind: "trace" | "steps"): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return await app.request(
    `/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/iterations/${ITERATION_ID}/${kind}`,
    { method: "GET", headers: { Authorization: "Bearer caller-bearer" } },
  );
}

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  vi.stubEnv("CONVEX_HTTP_URL", CONVEX_HTTP_URL);
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-service-token");
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  // The read audit's report; its outcome does not affect the response.
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true, recorded: true }), { status: 200 }),
  );
  convexQueryMock.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuiteRun") return Promise.resolve(RUN_DOC);
    if (name === "testSuites:getTestIteration")
      return Promise.resolve(ITERATION_DOC);
    return Promise.resolve(null);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("GET …/iterations/:iterationId/steps — artifact links", () => {
  it("forwards signed screenshot and recording links", async () => {
    convexActionMock.mockResolvedValue(
      traceEnvelope({ shot: SIGNED_SHOT, video: SIGNED_VIDEO }),
    );

    const res = await read("steps");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evidence).toBe("resolved");
    expect(body.items[0].evidence).toMatchObject({
      screenshotUrl: SIGNED_SHOT,
      videoUrl: SIGNED_VIDEO,
      videoMeta: { durationMs: 4_000 },
      videoOffsetMs: 1_500,
    });
  });

  it("reports links of any other shape as absent, keeping the rest of the evidence", async () => {
    convexActionMock.mockResolvedValue(
      traceEnvelope({ shot: STORAGE_SHOT, video: STORAGE_VIDEO }),
    );

    const res = await read("steps");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("/api/storage/");
    const evidence = JSON.parse(text).items[0].evidence;
    expect(evidence).not.toHaveProperty("screenshotUrl");
    expect(evidence).not.toHaveProperty("videoUrl");
    // Recording metadata only ever travels with a reachable recording.
    expect(evidence).not.toHaveProperty("videoMeta");
    expect(evidence).toMatchObject({
      videoOffsetMs: 1_500,
      source: "scripted",
    });
  });
});

describe("GET …/iterations/:iterationId/trace — artifact links", () => {
  it("forwards signed links unchanged", async () => {
    const envelope = traceEnvelope({ shot: SIGNED_SHOT, video: SIGNED_VIDEO });
    convexActionMock.mockResolvedValue(envelope);

    const res = await read("trace");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(envelope);
  });

  it("reports links of any other shape as null", async () => {
    convexActionMock.mockResolvedValue(
      traceEnvelope({ shot: STORAGE_SHOT, video: STORAGE_VIDEO }),
    );

    const res = await read("trace");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("/api/storage/");
    const body = JSON.parse(text);
    expect(body.videoUrl).toBeNull();
    expect(body.browserInteractionSteps[0].screenshotUrl).toBeNull();
    expect(body.messages).toEqual([{ role: "user", content: "open the cart" }]);
  });
});
