import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapWebBoundaryError } from "../boundary-error.js";
import { webErrorFromRoute } from "../errors.js";

const { drain, runCase, streamCase, disconnectAllServers } = vi.hoisted(() => ({
  drain: {
    current: undefined as
      | undefined
      | import("../../../services/lifecycle/drain.js").DrainCoordinator,
  },
  runCase: vi.fn(),
  streamCase: vi.fn(),
  disconnectAllServers: vi.fn(async () => {}),
}));

vi.mock("../../../services/lifecycle/drain.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/lifecycle/drain.js")
  >("../../../services/lifecycle/drain.js");
  return {
    ...actual,
    get serverDrain() {
      return drain.current;
    },
  };
});

vi.mock("../../shared/evals.js", async () => ({
  ...(await vi.importActual<object>("../../shared/evals.js")),
  runEvalTestCaseWithManager: runCase,
  streamEvalTestCaseWithManager: streamCase,
}));

vi.mock("../auth.js", async () => ({
  ...(await vi.importActual<object>("../auth.js")),
  withEphemeralConnection: async (
    c: { json: (body: unknown) => Response },
    _schema: unknown,
    run: (manager: unknown, body: unknown) => Promise<unknown>,
  ) => c.json(await run({ disconnectAllServers }, QUICK_RUN)),
  createAuthorizedManager: async () => ({ manager: { disconnectAllServers } }),
}));

vi.mock("../../../utils/v1-convex-token.js", async () => ({
  ...(await vi.importActual<object>("../../../utils/v1-convex-token.js")),
  getConvexBearerForRequest: async () => "token",
}));

vi.mock("../../../utils/harness/local/run-resources.js", async () => ({
  ...(await vi.importActual<object>(
    "../../../utils/harness/local/run-resources.js",
  )),
  anyUnattendedLocalHarness: async () => false,
}));

import { createDrainCoordinator } from "../../../services/lifecycle/drain.js";
import evalsRoutes from "../evals.js";

const QUICK_RUN = {
  projectId: "project-1",
  serverIds: ["server-1"],
  testCaseId: "test-case-1",
  model: "openai/gpt-5-mini",
  provider: "openai",
};

function post(path: string) {
  const app = new Hono();
  app.route("/api/web/evals", evalsRoutes);
  app.onError((error, c) => webErrorFromRoute(c, mapWebBoundaryError(error)));
  return app.request(`/api/web/evals${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify(QUICK_RUN),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  drain.current = createDrainCoordinator();
});

describe("quick runs and the shutdown drain", () => {
  it("drains a buffered quick run until it answers", async () => {
    let finish!: (value: unknown) => void;
    runCase.mockReturnValue(new Promise((resolve) => (finish = resolve)));

    const response = post("/run-test-case");
    await vi.waitFor(() =>
      expect(drain.current?.counts()).toEqual({ quick_run: 1 }),
    );
    finish({ ok: true });

    expect((await response).status).toBe(200);
    expect(drain.current?.counts()).toEqual({});
  });

  it("drains a streamed quick run until its stream completes", async () => {
    let complete!: () => void;
    streamCase.mockImplementation(
      async (
        _manager: unknown,
        _request: unknown,
        options: { onStreamComplete: () => void },
      ) => {
        complete = options.onStreamComplete;
        return new ReadableStream();
      },
    );

    expect((await post("/stream-test-case")).status).toBe(200);
    expect(drain.current?.counts()).toEqual({ quick_run: 1 });
    complete();

    await vi.waitFor(() => expect(drain.current?.counts()).toEqual({}));
    expect(disconnectAllServers).toHaveBeenCalledTimes(1);
  });

  it("releases a streamed quick run that fails before its stream opens", async () => {
    streamCase.mockRejectedValue(new Error("prepare failed"));

    expect((await post("/stream-test-case")).status).toBe(500);
    await vi.waitFor(() => expect(drain.current?.counts()).toEqual({}));
  });
});
