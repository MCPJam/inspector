/**
 * The backend's doorbells and the shutdown drain. A ring that reaches a
 * draining server is refused with a bare 503 (the backend's sweep re-delivers
 * it), and a pass a ring did start holds the drain until it settles.
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { drainState, passes } = vi.hoisted(() => ({
  drainState: { draining: false },
  passes: {
    runConnectionJob: vi.fn(),
    runChatSessionStagePass: vi.fn(),
    runJudgeSecondPass: vi.fn(),
  },
}));

// One coordinator for the file: the routers build their middleware when they
// load, so it has to exist by then. Each test settles what it starts.
vi.mock("../../../services/lifecycle/drain.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/lifecycle/drain.js")
  >("../../../services/lifecycle/drain.js");
  const real = actual.createDrainCoordinator();
  return {
    ...actual,
    serverDrain: { ...real, isDraining: () => drainState.draining },
  };
});
vi.mock("../../../services/server-connection-worker.js", () => ({
  runConnectionJob: passes.runConnectionJob,
}));
vi.mock("../../../services/chat-stage/chat-session-stage-pass.js", () => ({
  runChatSessionStagePass: passes.runChatSessionStagePass,
}));
vi.mock("../../../services/evals/judge-second-pass.js", () => ({
  runJudgeSecondPass: passes.runJudgeSecondPass,
}));

import { serverDrain } from "../../../services/lifecycle/drain.js";
import internalServerConnections from "../server-connections.js";
import internalChatStageDerivations from "../chat-stage-derivations.js";
import internalEvalJudgeCompletions from "../eval-judge-completions.js";
import internalAgentTurns from "../agent-turns.js";

const SERVICE_TOKEN = "test-inspector-service-token";

const DOORBELLS = [
  {
    name: "server connections",
    router: internalServerConnections,
    path: "/dispatch",
    body: { requestId: "req_1" },
    pass: passes.runConnectionJob,
  },
  {
    name: "chat stage derivations",
    router: internalChatStageDerivations,
    path: "/derivation-requested",
    body: {},
    pass: passes.runChatSessionStagePass,
  },
  {
    name: "judge completions",
    router: internalEvalJudgeCompletions,
    path: "/judge-completed",
    body: { runId: "run_1" },
    pass: passes.runJudgeSecondPass,
  },
];

function ring(router: Hono, path: string, body: unknown) {
  const app = new Hono();
  app.route("/doorbell", router);
  return app.request(`/doorbell${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-inspector-service-token": SERVICE_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", SERVICE_TOKEN);
  drainState.draining = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("doorbells while the server drains", () => {
  it.each([
    ...DOORBELLS,
    {
      name: "agent turns",
      router: internalAgentTurns,
      path: "/dispatch",
      body: {},
      pass: undefined,
    },
  ])("refuses a $name ring without starting a pass", async (doorbell) => {
    drainState.draining = true;

    const res = await ring(doorbell.router, doorbell.path, doorbell.body);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(doorbell.pass ?? vi.fn()).not.toHaveBeenCalled();
  });

  it.each(DOORBELLS)(
    "holds the drain for the $name pass a ring started",
    async (doorbell) => {
      let finish!: () => void;
      doorbell.pass.mockReturnValue(new Promise<void>((r) => (finish = r)));

      const res = await ring(doorbell.router, doorbell.path, doorbell.body);

      expect(res.status).toBe(202);
      expect(serverDrain.counts()).toEqual({ doorbell: 1 });
      finish();
      await vi.waitFor(() => expect(serverDrain.counts()).toEqual({}));
    },
  );
});
