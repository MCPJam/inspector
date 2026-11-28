import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rollout:
    vi.fn<(authorization: string | null | undefined) => Promise<boolean>>(),
  mutation: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock("../../../utils/server-canvas-rollout.js", () => ({
  resolveServerCanvasRollout: mocks.rollout,
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
// Capture's doctor pass, reduced to the handshake it reads the context from.
vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  return {
    ...actual,
    collectConnectedServerDoctorState: async (
      manager: import("@mcpjam/sdk").MCPClientManager,
      key: string,
    ) => ({ initInfo: manager.getInitializationInfo(key) }),
  };
});

import { Hono } from "hono";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  registerLocalConnectionScope,
  setManagerConnections,
} from "../../../utils/mcp-connections.js";
import { captureServerFeatures } from "../capture.js";
import { captureAccountKey } from "../connect-hook.js";
import {
  hostedContextHash,
  resetHostedContextsForTests,
} from "../connection-context.js";
import {
  OBSERVATION_FLUSH_INTERVAL_MS,
  flushLocalObservations,
  flushPendingHostedObservations,
  hostedFeatureObserver,
  localObservationFlushMiddleware,
  recordLocalObservation,
  resetLocalObservationsForTests,
} from "../observation-recorders.js";

type InitInfo = NonNullable<
  ReturnType<MCPClientManager["getInitializationInfo"]>
>;
type FakeManager = Pick<
  MCPClientManager,
  "getInitializationInfo" | "listServers" | "getConnectionStatus"
>;

const CAPABILITIES = {
  elicitation: {},
  extensions: { "io.modelcontextprotocol/ui": {} },
};

function fakeManager(
  protocolVersion: string | undefined,
  keys: string[] = ["srv_1"],
): MCPClientManager {
  const info: InitInfo = {
    protocolVersion,
    transport: "streamable-http",
    serverCapabilities: undefined,
    serverVersion: undefined,
    instructions: undefined,
    clientCapabilities: CAPABILITIES,
  };
  const fake: FakeManager = {
    getInitializationInfo: (key) => (keys.includes(key) ? info : undefined),
    listServers: () => keys,
    getConnectionStatus: () => "connected",
  };
  return fake as MCPClientManager;
}

/** The hash a connect capture of the same connection produces. */
async function capturedHash(manager: MCPClientManager, key: string) {
  const capture = await captureServerFeatures(manager, key, key, {
    accountKey: captureAccountKey(manager, key),
  });
  return capture.contextHash;
}

function sentWrites() {
  return mocks.mutation.mock.calls.map(([, args]) => args);
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  resetHostedContextsForTests();
  resetLocalObservationsForTests();
  mocks.rollout.mockReset().mockResolvedValue(true);
  mocks.mutation.mockReset().mockResolvedValue(undefined);
  mocks.setAuth.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hosted observations", () => {
  it("records under the hash the capture would produce, with an empty cache", async () => {
    vi.useFakeTimers();
    const manager = fakeManager("2025-11-25");
    setManagerConnections(manager, {
      srv_1: [
        {
          key: "srv_1",
          serverId: "srv_1",
          connectionId: "conn_default",
          label: "Work",
          isDefault: true,
        },
      ],
    });
    const observer = hostedFeatureObserver(
      "prj_1",
      "hosted-token",
      () => manager,
      "user_a",
    );
    observer({ serverId: "srv_1", featureIds: ["tool-results.text"], at: 3 });
    observer({ serverId: "srv_1", featureIds: ["tool-results.text"], at: 4 });

    await vi.advanceTimersByTimeAsync(OBSERVATION_FLUSH_INTERVAL_MS);
    await settle();
    vi.useRealTimers();
    const expected = await capturedHash(manager, "srv_1");
    expect(expected).toMatch(/^ctx_[0-9a-f]{16}$/);
    expect(mocks.rollout).toHaveBeenCalledWith("hosted-token");
    expect(sentWrites()).toEqual([
      expect.objectContaining({
        projectId: "prj_1",
        serverId: "srv_1",
        contextHash: expected,
        observations: [expect.objectContaining({ count: 2, lastSeenAt: 4 })],
      }),
    ]);
    expect(
      hostedContextHash({
        projectId: "prj_1",
        serverId: "srv_1",
        actorId: "user_a",
      }),
    ).toBe(expected);
    expect(
      hostedContextHash({
        projectId: "prj_1",
        serverId: "srv_1",
        actorId: "user_b",
      }),
    ).toBeUndefined();
  });

  it("records without an actor but caches no context for the bridge", async () => {
    vi.useFakeTimers();
    const observer = hostedFeatureObserver(
      "prj_1",
      "t",
      () => fakeManager("2025-11-25"),
      null,
    );
    observer({ serverId: "srv_1", featureIds: ["a"], at: 1 });
    await vi.advanceTimersByTimeAsync(OBSERVATION_FLUSH_INTERVAL_MS);
    await settle();
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
    expect(
      hostedContextHash({ projectId: "prj_1", serverId: "srv_1", actorId: "" }),
    ).toBeUndefined();
  });

  it("files two managers' traffic under their own negotiated versions", async () => {
    vi.useFakeTimers();
    const legacy = fakeManager("2025-06-18");
    const modern = fakeManager("2026-07-28");
    hostedFeatureObserver(
      "prj_1",
      "t",
      () => legacy,
      "user_a",
    )({
      serverId: "srv_1",
      featureIds: ["tool-results.text"],
      at: 1,
    });
    hostedFeatureObserver(
      "prj_1",
      "t",
      () => modern,
      "user_a",
    )({
      serverId: "srv_1",
      featureIds: ["tool-results.text"],
      at: 2,
    });
    await vi.advanceTimersByTimeAsync(OBSERVATION_FLUSH_INTERVAL_MS);
    await settle();
    vi.useRealTimers();
    const hashes = sentWrites().map((write) => write.contextHash);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(hashes).toEqual([
      await capturedHash(legacy, "srv_1"),
      await capturedHash(modern, "srv_1"),
    ]);
  });

  it("files an account alias under its project server and account", async () => {
    vi.useFakeTimers();
    const manager = fakeManager("2025-11-25", ["srv_1", "srv_1::acct_2"]);
    setManagerConnections(manager, {
      srv_1: [
        {
          key: "srv_1",
          serverId: "srv_1",
          connectionId: "acct_1",
          label: "A",
          isDefault: true,
        },
        {
          key: "srv_1::acct_2",
          serverId: "srv_1",
          connectionId: "acct_2",
          label: "B",
          isDefault: false,
        },
      ],
    });
    const observer = hostedFeatureObserver(
      "prj_1",
      "t",
      () => manager,
      "user_a",
    );
    observer({ serverId: "srv_1", featureIds: ["a"], at: 1 });
    observer({ serverId: "srv_1::acct_2", featureIds: ["a"], at: 1 });
    await vi.advanceTimersByTimeAsync(OBSERVATION_FLUSH_INTERVAL_MS);
    await settle();
    const writes = sentWrites();
    expect(writes.map((write) => write.serverId)).toEqual(["srv_1", "srv_1"]);
    expect(writes[0].contextHash).not.toBe(writes[1].contextHash);
  });

  it("records nothing before the connection has negotiated", () => {
    vi.useFakeTimers();
    const observer = hostedFeatureObserver(
      "prj_1",
      "t",
      () => fakeManager(undefined),
      "user_a",
    );
    observer({ serverId: "srv_1", featureIds: ["a"], at: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes nothing when the rollout is off at the flush", async () => {
    vi.useFakeTimers();
    mocks.rollout.mockResolvedValue(false);
    const observer = hostedFeatureObserver(
      "prj_1",
      "t",
      () => fakeManager("2025-11-25"),
      "user_a",
    );
    observer({ serverId: "srv_1", featureIds: ["a"], at: 1 });
    await vi.advanceTimersByTimeAsync(OBSERVATION_FLUSH_INTERVAL_MS);
    await settle();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("leaves keeping a rollout no to the shared gate, so a yes is acted on at the next flush", async () => {
    vi.useFakeTimers();
    mocks.rollout.mockResolvedValue(false);
    const manager = fakeManager("2025-11-25");
    // Two managers for one bearer, as two hosted requests of one member.
    const first = hostedFeatureObserver("prj_1", "t", () => manager, "user_a");
    const second = hostedFeatureObserver("prj_1", "t", () => manager, "user_a");
    first({ serverId: "srv_1", featureIds: ["a"], at: 1 });
    await vi.advanceTimersByTimeAsync(OBSERVATION_FLUSH_INTERVAL_MS);
    await settle();
    expect(mocks.mutation).not.toHaveBeenCalled();

    // `resolveServerCanvasRollout` keeps its own answers; this path keeps none.
    mocks.rollout.mockResolvedValue(true);
    second({ serverId: "srv_1", featureIds: ["a"], at: 2 });
    await vi.advanceTimersByTimeAsync(OBSERVATION_FLUSH_INTERVAL_MS);
    await settle();
    expect(mocks.rollout).toHaveBeenCalledTimes(2);
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
  });

  it("flushes a buffer still inside its interval at shutdown, once", async () => {
    vi.useFakeTimers();
    const observer = hostedFeatureObserver(
      "prj_1",
      "t",
      () => fakeManager("2025-11-25"),
      "user_a",
    );
    observer({ serverId: "srv_1", featureIds: ["a"], at: 1 });
    await flushPendingHostedObservations();
    expect(mocks.mutation).toHaveBeenCalledTimes(1);

    // The interval's own timer no longer fires, and nothing is left pending.
    await vi.advanceTimersByTimeAsync(OBSERVATION_FLUSH_INTERVAL_MS);
    await flushPendingHostedObservations();
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a shutdown flush at its deadline", async () => {
    vi.useFakeTimers();
    mocks.mutation.mockReturnValue(new Promise(() => undefined));
    const observer = hostedFeatureObserver(
      "prj_1",
      "t",
      () => fakeManager("2025-11-25"),
      "user_a",
    );
    observer({ serverId: "srv_1", featureIds: ["a"], at: 1 });
    let finished = false;
    const flushing = flushPendingHostedObservations(1_000).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(finished).toBe(true);
  });

  it("asks again on every flush while the rollout says yes", async () => {
    vi.useFakeTimers();
    const observer = hostedFeatureObserver(
      "prj_1",
      "t",
      () => fakeManager("2025-11-25"),
      "user_a",
    );
    for (const at of [1, 2]) {
      observer({ serverId: "srv_1", featureIds: ["a"], at });
      await vi.advanceTimersByTimeAsync(OBSERVATION_FLUSH_INTERVAL_MS);
      await settle();
    }
    expect(mocks.rollout).toHaveBeenCalledTimes(2);
    expect(mocks.mutation).toHaveBeenCalledTimes(2);
  });
});

describe("local observations", () => {
  function localManager(protocolVersion = "2025-11-25") {
    const manager = fakeManager(protocolVersion, ["My Server"]);
    registerLocalConnectionScope(manager, "My Server", {
      projectId: "prj_local",
      serverId: "srv_local",
      accountKey: "cred_1",
    });
    return manager;
  }

  it("maps the manager key to its project server and live context", async () => {
    const manager = localManager();
    recordLocalObservation(manager, {
      serverId: "My Server",
      featureIds: ["tool-results.text"],
      at: 7,
    });
    await flushLocalObservations(
      "Bearer user-token",
      OBSERVATION_FLUSH_INTERVAL_MS,
    );
    const capture = await captureServerFeatures(
      manager,
      "My Server",
      "srv_local",
      {
        accountKey: captureAccountKey(manager, "My Server", "cred_1"),
      },
    );
    expect(mocks.rollout).toHaveBeenCalledWith("Bearer user-token");
    expect(mocks.setAuth).toHaveBeenCalledWith("user-token");
    expect(sentWrites()).toEqual([
      expect.objectContaining({
        projectId: "prj_local",
        serverId: "srv_local",
        contextHash: capture.contextHash,
        observations: [
          {
            featureId: "tool-results.text",
            count: 1,
            firstSeenAt: 7,
            lastSeenAt: 7,
            source: "rpc",
          },
        ],
      }),
    ]);
  });

  it("ignores keys no local connect registered", async () => {
    recordLocalObservation(fakeManager("2025-11-25", ["My Server"]), {
      serverId: "My Server",
      featureIds: ["a"],
      at: 1,
    });
    await flushLocalObservations("Bearer t", OBSERVATION_FLUSH_INTERVAL_MS);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("writes nothing when the rollout is off for the flushing caller", async () => {
    mocks.rollout.mockResolvedValue(false);
    recordLocalObservation(localManager(), {
      serverId: "My Server",
      featureIds: ["a"],
      at: 1,
    });
    await flushLocalObservations("Bearer t", OBSERVATION_FLUSH_INTERVAL_MS);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("waits for a bearer and for the interval", async () => {
    recordLocalObservation(localManager(), {
      serverId: "My Server",
      featureIds: ["a"],
      at: 1,
    });
    await flushLocalObservations(undefined, OBSERVATION_FLUSH_INTERVAL_MS);
    await flushLocalObservations("Bearer t", OBSERVATION_FLUSH_INTERVAL_MS - 1);
    expect(mocks.rollout).not.toHaveBeenCalled();
    await flushLocalObservations("Bearer t", OBSERVATION_FLUSH_INTERVAL_MS);
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
  });

  it("flushes after a local API request with that request's bearer", async () => {
    vi.useFakeTimers({ now: OBSERVATION_FLUSH_INTERVAL_MS * 2 });
    recordLocalObservation(localManager(), {
      serverId: "My Server",
      featureIds: ["a"],
      at: 1,
    });
    const app = new Hono();
    app.use("*", localObservationFlushMiddleware);
    app.get("/servers", (c) => c.json({ ok: true }));

    const response = await app.request("/servers", {
      headers: { Authorization: "Bearer request-token" },
    });
    expect(response.status).toBe(200);
    await vi.runAllTimersAsync();
    expect(mocks.rollout).toHaveBeenCalledWith("Bearer request-token");
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
  });
});
