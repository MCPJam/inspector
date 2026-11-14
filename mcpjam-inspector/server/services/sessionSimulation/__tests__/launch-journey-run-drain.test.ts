import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A swarm launch and the shutdown drain: refused before anything is created
 * once the drain has begun, and otherwise registered from acceptance until its
 * runner settles, so a shutdown that begins before the runner starts still
 * waits for it.
 */

const { drain, createRunMock, startRunMock, queryMock } = vi.hoisted(() => ({
  drain: {
    current: undefined as
      undefined | import("../../lifecycle/drain.js").DrainCoordinator,
  },
  createRunMock: vi.fn(),
  startRunMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock("../../lifecycle/drain.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../lifecycle/drain.js")
  >("../../lifecycle/drain.js");
  return {
    ...actual,
    get serverDrain() {
      return drain.current;
    },
  };
});
vi.mock("../../swarm-agent.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createJourneyRun: createRunMock,
}));
vi.mock("../swarm-runner.js", () => ({ startJourneyRun: startRunMock }));
vi.mock("../../../routes/web/auth.js", () => ({
  createAuthorizedManager: vi.fn(),
}));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: queryMock }),
}));
vi.mock("../../../utils/computers/hosted-browser-availability.js", () => ({
  isHostedBrowserAvailableFor: async () => false,
}));
vi.mock("../../../utils/harness/local/run-resources.js", () => ({
  eligibleUnattendedLocalHarnesses: async () => [],
}));

import { createDrainCoordinator } from "../../lifecycle/drain.js";
import { launchJourneyRun } from "../launch-journey-run.js";

const DEPS = {
  bearerToken: "create-jwt",
  getRunBearer: async () => "run-jwt",
  xaaIssuer: "https://issuer.test",
  callerContext: {} as never,
};
const INPUT = { projectId: "proj_1", journeyRefId: "jrn_1", launchKey: "k" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  drain.current = createDrainCoordinator();
  queryMock.mockResolvedValue(undefined);
  createRunMock.mockResolvedValue({
    runId: "run_1",
    projectId: "proj_1",
    snapshot: {
      hosts: [{ hostId: "h1", targetId: "t1", serverIds: [], modelId: "m" }],
      sessionsPerTarget: 1,
      maxTurns: 4,
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("launchJourneyRun and the shutdown drain", () => {
  it("refuses a launch once draining, before creating a run", async () => {
    drain.current?.begin();

    await expect(launchJourneyRun(DEPS, INPUT)).rejects.toMatchObject({
      status: 429,
      details: { reason: "SERVER_DRAINING" },
    });
    expect(createRunMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it("holds the drain from acceptance until the runner settles", async () => {
    let finish!: () => void;
    startRunMock.mockReturnValue(new Promise<void>((r) => (finish = r)));

    await launchJourneyRun(DEPS, INPUT);
    // Registered before the runner has even been started.
    expect(startRunMock).not.toHaveBeenCalled();
    expect(drain.current?.counts()).toEqual({ swarm_run: 1 });

    await vi.waitFor(() => expect(startRunMock).toHaveBeenCalledTimes(1));
    finish();
    await vi.waitFor(() => expect(drain.current?.counts()).toEqual({}));
  });

  it("holds the drain while the run is still being created", async () => {
    let created!: () => void;
    const createRun = createRunMock.getMockImplementation();
    createRunMock.mockImplementation(
      () => new Promise((r) => (created = () => r(createRun?.()))),
    );
    startRunMock.mockResolvedValue(undefined);

    const launch = launchJourneyRun(DEPS, INPUT);
    await vi.waitFor(() => expect(createRunMock).toHaveBeenCalledTimes(1));
    expect(drain.current?.counts()).toEqual({ swarm_run: 1 });

    created();
    await launch;
    await vi.waitFor(() => expect(drain.current?.counts()).toEqual({}));
  });

  it.each([
    [
      "fails",
      () => createRunMock.mockRejectedValue(new Error("backend 500")),
      "rejected",
    ],
    [
      "is deduped",
      () => createRunMock.mockResolvedValue({ runId: "run_1", deduped: true }),
      "fulfilled",
    ],
  ])(
    "releases the drain when the launch %s",
    async (_name, arrange, status) => {
      arrange();

      const [launch] = await Promise.allSettled([
        launchJourneyRun(DEPS, INPUT),
      ]);
      expect(launch.status).toBe(status);
      await vi.waitFor(() => expect(drain.current?.counts()).toEqual({}));
      expect(startRunMock).not.toHaveBeenCalled();
    },
  );

  it("releases the drain when the runner fails", async () => {
    startRunMock.mockRejectedValue(new Error("runner exploded"));

    await launchJourneyRun(DEPS, INPUT);
    await vi.waitFor(() => expect(drain.current?.counts()).toEqual({}));
    expect(startRunMock).toHaveBeenCalledTimes(1);
  });
});
