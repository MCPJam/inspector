import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = mocks.setAuth;
    mutation = mocks.mutation;
  },
}));
vi.mock("../../../env.js", () => ({
  getInspectorClientRuntimeConfig: () => ({
    convexUrl: "https://example.convex.cloud",
  }),
}));

import { getFunctionName } from "convex/server";
import {
  FeatureObservationBuffer,
  MAX_BUFFERED_SERVERS,
  MAX_OBSERVATION_COUNT,
  MAX_OBSERVATIONS_PER_WRITE,
  convexObservationWriter,
  flushFeatureObservations,
  type FeatureObservationWrite,
} from "../observations.js";

const TARGET = {
  projectId: "prj_1",
  serverId: "srv_1",
  contextHash: "ctx_0123456789abcdef",
};

function deps(
  overrides: Partial<Parameters<typeof flushFeatureObservations>[1]> = {},
) {
  const writes: FeatureObservationWrite[] = [];
  return {
    writes,
    deps: {
      canvasOn: async () => true,
      write: async (args: FeatureObservationWrite) => {
        writes.push(args);
      },
      ...overrides,
    },
  };
}

describe("FeatureObservationBuffer", () => {
  it("tallies count, first and last seen, and the latest source", () => {
    const buffer = new FeatureObservationBuffer();
    buffer.record(TARGET, ["tool-results.text"], 20, "rpc");
    buffer.record(TARGET, ["tool-results.text"], 10, "apps-bridge");
    buffer.record(TARGET, ["tool-results.text"], 30, "apps-bridge", 3);
    const [drained] = buffer.take();
    expect(drained.target).toEqual(TARGET);
    expect(drained.tallies.get("tool-results.text")).toEqual({
      count: 5,
      firstSeenAt: 10,
      lastSeenAt: 30,
      source: "apps-bridge",
    });
    expect(buffer.size).toBe(0);
  });

  it("caps counts and the number of targets it holds", () => {
    const buffer = new FeatureObservationBuffer();
    buffer.record(TARGET, ["a"], 1, "rpc", MAX_OBSERVATION_COUNT);
    buffer.record(TARGET, ["a"], 2, "rpc", 5);
    for (let index = 0; index < MAX_BUFFERED_SERVERS + 5; index += 1)
      buffer.record({ ...TARGET, serverId: `srv-${index}` }, ["a"], 1, "rpc");
    const drained = buffer.take();
    expect(drained[0].tallies.get("a")?.count).toBe(MAX_OBSERVATION_COUNT);
    expect(drained).toHaveLength(MAX_BUFFERED_SERVERS);
  });

  it("keeps one server's contexts apart", () => {
    const buffer = new FeatureObservationBuffer();
    buffer.record(TARGET, ["a"], 1, "rpc");
    buffer.record({ ...TARGET, contextHash: "ctx_other" }, ["a"], 1, "rpc");
    expect(buffer.take().map((entry) => entry.target.contextHash)).toEqual([
      TARGET.contextHash,
      "ctx_other",
    ]);
  });
});

describe("flushFeatureObservations", () => {
  beforeEach(() => {
    mocks.mutation.mockReset();
    mocks.setAuth.mockReset();
  });

  it("writes ids, counts and times only, for the target's server and context", async () => {
    const buffer = new FeatureObservationBuffer();
    buffer.record(
      TARGET,
      ["tool-results.text", "request-control.progress"],
      5,
      "rpc",
    );
    const { writes, deps: flushDeps } = deps();

    await expect(flushFeatureObservations(buffer, flushDeps)).resolves.toEqual({
      writes: 1,
      observations: 2,
    });

    expect(writes).toHaveLength(1);
    const [write] = writes;
    expect(write).toMatchObject(TARGET);
    expect(write.flushId).toMatch(/^[0-9a-f-]{36}$/);
    expect(write.observations).toEqual([
      {
        featureId: "request-control.progress",
        count: 1,
        firstSeenAt: 5,
        lastSeenAt: 5,
        source: "rpc",
      },
      {
        featureId: "tool-results.text",
        count: 1,
        firstSeenAt: 5,
        lastSeenAt: 5,
        source: "rpc",
      },
    ]);
    expect(buffer.size).toBe(0);
  });

  it("writes nothing and keeps nothing when the rollout is off", async () => {
    const buffer = new FeatureObservationBuffer();
    buffer.record(TARGET, ["tool-results.text"], 5, "rpc");
    const write = vi.fn();
    const { deps: flushDeps } = deps({ canvasOn: async () => false, write });

    await flushFeatureObservations(buffer, flushDeps);
    expect(write).not.toHaveBeenCalled();
    expect(buffer.size).toBe(0);
  });

  it("treats a failed rollout check as off", async () => {
    const buffer = new FeatureObservationBuffer();
    buffer.record(TARGET, ["tool-results.text"], 5, "rpc");
    const write = vi.fn();
    const { deps: flushDeps } = deps({
      canvasOn: () => Promise.reject(new Error("flag service down")),
      write,
    });
    await flushFeatureObservations(buffer, flushDeps);
    expect(write).not.toHaveBeenCalled();
  });

  it("retries a failed write once with the same flushId", async () => {
    const buffer = new FeatureObservationBuffer();
    buffer.record(TARGET, ["tool-results.text"], 5, "rpc");
    const write = vi
      .fn<(args: FeatureObservationWrite) => Promise<void>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);
    const { deps: flushDeps } = deps({ write });

    await expect(flushFeatureObservations(buffer, flushDeps)).resolves.toEqual({
      writes: 1,
      observations: 1,
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][0]).toEqual(write.mock.calls[1][0]);
  });

  it("gives up after the retry without throwing", async () => {
    const buffer = new FeatureObservationBuffer();
    buffer.record(TARGET, ["tool-results.text"], 5, "rpc");
    const write = vi.fn().mockRejectedValue(new Error("network"));
    const { deps: flushDeps } = deps({ write });
    await expect(flushFeatureObservations(buffer, flushDeps)).resolves.toEqual({
      writes: 0,
      observations: 0,
    });
  });

  it("splits a server's observations into calls of at most 200", async () => {
    const buffer = new FeatureObservationBuffer();
    const ids = Array.from(
      { length: MAX_OBSERVATIONS_PER_WRITE + 1 },
      (_, index) => `feature-${String(index).padStart(3, "0")}`,
    );
    buffer.record(TARGET, ids, 5, "rpc");
    const { writes, deps: flushDeps } = deps();
    await flushFeatureObservations(buffer, flushDeps);
    expect(writes.map((write) => write.observations.length)).toEqual([
      MAX_OBSERVATIONS_PER_WRITE,
      1,
    ]);
    expect(new Set(writes.map((write) => write.flushId)).size).toBe(2);
  });
});

describe("convexObservationWriter", () => {
  beforeEach(() => {
    mocks.mutation.mockReset();
    mocks.setAuth.mockReset();
  });

  it("calls recordFeatureObservations as the bearer's user", async () => {
    const args: FeatureObservationWrite = {
      ...TARGET,
      flushId: "flush-1",
      observations: [],
    };
    await convexObservationWriter("Bearer user-token")(args);
    expect(mocks.setAuth).toHaveBeenCalledWith("user-token");
    const [reference, sent] = mocks.mutation.mock.calls[0];
    expect(getFunctionName(reference)).toBe(
      "serverFeatureObservations:recordFeatureObservations",
    );
    expect(sent).toEqual(args);
  });

  it("does not call Convex without a bearer", async () => {
    await convexObservationWriter(undefined)({
      ...TARGET,
      flushId: "flush-1",
      observations: [],
    });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
