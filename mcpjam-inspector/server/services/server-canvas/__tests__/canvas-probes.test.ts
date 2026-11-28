import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runServerProbes: vi.fn() }));
vi.mock("../probe-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../probe-runner.js")>()),
  runServerProbes: mocks.runServerProbes,
}));

import { ConvexError } from "convex/values";
import type { MCPClientManager, OAuthFlowSummary, ProbeSummary } from "@mcpjam/sdk";
import { startCanvasProbes } from "../canvas-probes.js";
import { PROBE_RESULTS_MAX_AGE_MS, ProbeCadence } from "../probe-cadence.js";
import { CAPTURE_FAILED_ATTEMPT } from "../probe-results.js";
import type { CanvasConnectEvent } from "../connect-hook.js";
import { doctorState } from "./probe-fixtures.js";

const SUMMARIES: ProbeSummary[] = [
  { probeId: "http-transport", status: "ok", coverage: "complete", at: 1, values: {} },
];
const OAUTH: OAuthFlowSummary = {
  completedAt: 3,
  resourceIndicatorSent: true,
  scopesRequested: ["read"],
  scopesGranted: ["read"],
  issReturned: true,
  issValidated: true,
  refreshTokenIssued: false,
};

function event(overrides: Partial<CanvasConnectEvent> = {}): CanvasConnectEvent {
  return {
    hosted: false,
    projectId: "prj_1",
    serverId: "srv_1",
    managerKey: "Fixture",
    manager: {} as MCPClientManager,
    convexBearer: "Bearer user-token",
    serverUrl: "https://srv.example.com/mcp",
    capture: {
      snapshot: { version: 3, capturedAt: 1, servers: [{ serverId: "srv_1", tools: [] }] },
      context: { transport: "streamable-http", era: "legacy" },
      contextHash: "ctx_0123456789abcdef",
      doctor: doctorState(),
    },
    oauthFlow: OAUTH,
    ...overrides,
  };
}

/** A capture whose tools could not be listed. */
function failedCaptureEvent(): CanvasConnectEvent {
  const base = event();
  return {
    ...base,
    capture: {
      ...base.capture,
      snapshot: {
        version: 3,
        capturedAt: 1,
        servers: [{ serverId: "srv_1", tools: [], captureError: "fetch failed" }],
      },
    },
  };
}

let now = 1_000;
let release: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  now = 1_000;
  mocks.runServerProbes.mockImplementation(() => {
    let releaseConnection: () => void = () => undefined;
    const connectionBound = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    release = releaseConnection;
    return { connectionBound, summaries: connectionBound.then(() => SUMMARIES) };
  });
});

function deps(overrides: Record<string, unknown> = {}) {
  return {
    rollout: vi.fn(async () => true),
    write: vi.fn(async () => true),
    cadence: new ProbeCadence(),
    now: () => now,
    ...overrides,
  };
}

describe("startCanvasProbes", () => {
  it("stores the probes with the capture's context and OAuth-flow summary", async () => {
    const dependencies = deps();
    const handle = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalled());
    release();
    await expect(handle.outcome).resolves.toBe("stored");
    expect(dependencies.write).toHaveBeenCalledWith("Bearer user-token", {
      projectId: "prj_1",
      serverId: "srv_1",
      contextHash: "ctx_0123456789abcdef",
      captureContext: { transport: "streamable-http", era: "legacy" },
      probes: SUMMARIES,
      oauthFlow: OAUTH,
    });
  });

  it("runs nothing and writes nothing when the rollout is off", async () => {
    const dependencies = deps({ rollout: vi.fn(async () => false) });
    const handle = startCanvasProbes(event(), {}, dependencies);
    await expect(handle.outcome).resolves.toBe("rollout-off");
    await expect(handle.connectionReleased).resolves.toBeUndefined();
    expect(mocks.runServerProbes).not.toHaveBeenCalled();
    expect(dependencies.write).not.toHaveBeenCalled();
  });

  it("writes nothing when the rollout turns off while probes run", async () => {
    const rollout = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const dependencies = deps({ rollout });
    const handle = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalled());
    release();
    await expect(handle.outcome).resolves.toBe("rollout-off");
    expect(dependencies.write).not.toHaveBeenCalled();
  });

  it("probes a context once a day on connect, and always on Refresh", async () => {
    const dependencies = deps();
    const first = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(1));
    release();
    await expect(first.outcome).resolves.toBe("stored");

    now += PROBE_RESULTS_MAX_AGE_MS - 1;
    await expect(startCanvasProbes(event(), {}, dependencies).outcome).resolves.toBe(
      "not-due",
    );

    const changed = event({
      capture: { ...event().capture, contextHash: "ctx_fedcba9876543210" },
    });
    const other = startCanvasProbes(changed, {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(2));
    release();
    await expect(other.outcome).resolves.toBe("stored");

    const refresh = startCanvasProbes(event(), { force: true }, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(3));
    release();
    await expect(refresh.outcome).resolves.toBe("stored");

    now += PROBE_RESULTS_MAX_AGE_MS;
    const stale = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(4));
    release();
    await expect(stale.outcome).resolves.toBe("stored");
  });

  it("runs again on the next connect when the write failed", async () => {
    const dependencies = deps({
      write: vi
        .fn()
        .mockRejectedValueOnce(new Error("convex down"))
        .mockResolvedValue(true),
    });
    const failed = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(1));
    release();
    await expect(failed.outcome).resolves.toBe("write-failed");
    // A network failure is not the summary's fault: no second try without it.
    expect(dependencies.write).toHaveBeenCalledTimes(1);

    const retried = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(2));
    release();
    await expect(retried.outcome).resolves.toBe("stored");
  });

  it("runs one probe set per context at a time", async () => {
    const dependencies = deps();
    const first = startCanvasProbes(event(), { force: true }, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(1));
    await expect(
      startCanvasProbes(event(), { force: true }, dependencies).outcome,
    ).resolves.toBe("already-running");
    release();
    await expect(first.outcome).resolves.toBe("stored");
  });

  it("does nothing without a bearer", async () => {
    const dependencies = deps();
    const handle = startCanvasProbes(event({ convexBearer: undefined }), {}, dependencies);
    await expect(handle.outcome).resolves.toBe("no-bearer");
    expect(dependencies.rollout).not.toHaveBeenCalled();
    expect(mocks.runServerProbes).not.toHaveBeenCalled();
  });

  it.each([
    [
      "its evidence check",
      new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "The OAuth summary issuer must be an http or https URL.",
      }),
    ],
    [
      "Convex's argument validator",
      new Error(
        "[Request ID: 1] Server Error\nArgumentValidationError: Object contains extra field `x` that is not in the validator.",
      ),
    ],
  ])("writes the run again without an OAuth summary %s refused", async (_by, refusal) => {
    const write = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValue(true);
    const handle = startCanvasProbes(event(), {}, deps({ write }));
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalled());
    release();
    await expect(handle.outcome).resolves.toBe("stored");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]?.[1]).toHaveProperty("oauthFlow");
    expect(write.mock.calls[1]?.[1]).not.toHaveProperty("oauthFlow");
    expect(write.mock.calls[1]?.[1]).toMatchObject({ probes: SUMMARIES });
  });

  it.each([
    ["a network error", new Error("fetch failed")],
    ["an auth error", new Error("Unauthenticated")],
    ["another backend refusal", new ConvexError({ code: "FORBIDDEN", message: "No access." })],
  ])("does not write again without the summary after %s", async (_kind, error) => {
    const write = vi.fn().mockRejectedValue(error);
    const handle = startCanvasProbes(event(), {}, deps({ write }));
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalled());
    release();
    await expect(handle.outcome).resolves.toBe("write-failed");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("says when there was nowhere to write, and probes again next time", async () => {
    const dependencies = deps({ write: vi.fn(async () => false) });
    const first = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(1));
    release();
    await expect(first.outcome).resolves.toBe("no-convex-url");

    const next = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(2));
    release();
    await expect(next.outcome).resolves.toBe("no-convex-url");
  });

  it("stores the OAuth summary alone when the probes are not due", async () => {
    const dependencies = deps();
    const first = startCanvasProbes(event({ oauthFlow: undefined }), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(1));
    release();
    await expect(first.outcome).resolves.toBe("stored");

    await expect(startCanvasProbes(event(), {}, dependencies).outcome).resolves.toBe(
      "not-due",
    );
    expect(mocks.runServerProbes).toHaveBeenCalledTimes(1);
    expect(dependencies.write).toHaveBeenLastCalledWith("Bearer user-token", {
      projectId: "prj_1",
      serverId: "srv_1",
      contextHash: "ctx_0123456789abcdef",
      captureContext: { transport: "streamable-http", era: "legacy" },
      probes: [],
      oauthFlow: OAUTH,
    });

    // Nothing to store when there is no summary either.
    dependencies.write.mockClear();
    await expect(
      startCanvasProbes(event({ oauthFlow: undefined }), {}, dependencies).outcome,
    ).resolves.toBe("not-due");
    expect(dependencies.write).not.toHaveBeenCalled();
  });

  it("marks a run after a failed capture and probes again on the next connect", async () => {
    const dependencies = deps();
    const failed = startCanvasProbes(failedCaptureEvent(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(1));
    release();
    await expect(failed.outcome).resolves.toBe("stored");
    expect(dependencies.write).toHaveBeenCalledWith(
      "Bearer user-token",
      expect.objectContaining({ attemptError: CAPTURE_FAILED_ATTEMPT }),
    );

    const next = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(2));
    release();
    await expect(next.outcome).resolves.toBe("stored");
    expect(dependencies.write).toHaveBeenLastCalledWith(
      "Bearer user-token",
      expect.not.objectContaining({ attemptError: expect.anything() }),
    );
  });

  it("starts the hosted budget only once the probes start", async () => {
    vi.useFakeTimers();
    try {
      const rollout = vi.fn(
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1_000)),
      );
      const handle = startCanvasProbes(event({ hosted: true }), {}, deps({ rollout }));
      let released = false;
      void handle.connectionReleased.then(() => {
        released = true;
      });
      await vi.advanceTimersByTimeAsync(3_500);
      expect(mocks.runServerProbes).toHaveBeenCalled();
      expect(released).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(released).toBe(true);
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      await handle.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands its handle to the caller as the probes start", () => {
    const onStarted = vi.fn();
    const handle = startCanvasProbes(event(), { onStarted }, deps());
    expect(onStarted).toHaveBeenCalledWith(handle);
  });

  it("never holds a hosted connection past the hosted budget", async () => {
    vi.useFakeTimers();
    try {
      const handle = startCanvasProbes(event({ hosted: true }), {}, deps());
      let released = false;
      void handle.connectionReleased.then(() => {
        released = true;
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(released).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(released).toBe(true);
      release();
      await handle.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["not due", false],
    ["already running", true],
  ])(
    "lets a hosted connection go when the probes are %s, whatever the summary write does",
    async (_case, running) => {
      const cadence = new ProbeCadence();
      const key = {
        projectId: "prj_1",
        serverId: "srv_1",
        contextHash: "ctx_0123456789abcdef",
      };
      if (running) cadence.begin(key);
      else cadence.record(key, now);
      const write = vi.fn(() => new Promise<boolean>(() => undefined));
      const handle = startCanvasProbes(event({ hosted: true }), {}, deps({ cadence, write }));
      await handle.connectionReleased;
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
      expect(mocks.runServerProbes).not.toHaveBeenCalled();
    },
  );

  it("skips the probes and lets the connection go when the rollout recheck does not answer", async () => {
    vi.useFakeTimers();
    try {
      const dependencies = deps({
        rollout: vi.fn(() => new Promise<boolean>(() => undefined)),
      });
      const handle = startCanvasProbes(event({ hosted: true }), {}, dependencies);
      let released = false;
      void handle.connectionReleased.then(() => {
        released = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(released).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(handle.outcome).resolves.toBe("rollout-off");
      expect(released).toBe(true);
      expect(mocks.runServerProbes).not.toHaveBeenCalled();

      // The context's claim was let go: the next connect probes.
      dependencies.rollout.mockResolvedValue(true);
      const next = startCanvasProbes(event({ hosted: true }), {}, dependencies);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runServerProbes).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(0);
      await expect(next.outcome).resolves.toBe("stored");
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes again on the next connect when a connection-bound probe failed", async () => {
    const failedEvents: ProbeSummary = {
      probeId: "events-list",
      status: "failed",
      coverage: "not-captured",
      at: 1,
      values: {},
    };
    mocks.runServerProbes.mockImplementationOnce(() => {
      const connectionBound = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        connectionBound,
        summaries: connectionBound.then(() => [...SUMMARIES, failedEvents]),
      };
    });
    const dependencies = deps();
    const first = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(1));
    release();
    await expect(first.outcome).resolves.toBe("stored");

    const next = startCanvasProbes(event(), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(2));
    release();
    await expect(next.outcome).resolves.toBe("stored");
    await expect(startCanvasProbes(event(), {}, dependencies).outcome).resolves.toBe(
      "not-due",
    );
  });

  it("probes again on the next connect when the local connection was replaced during the run", async () => {
    type ManagedClient = NonNullable<ReturnType<MCPClientManager["getManagedClient"]>>;
    const before = {} as ManagedClient;
    const after = {} as ManagedClient;
    let current = before;
    const partial: Partial<MCPClientManager> = { getManagedClient: () => current };
    const manager = partial as MCPClientManager;
    const dependencies = deps();
    const first = startCanvasProbes(event({ manager }), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(1));
    current = after;
    release();
    await expect(first.outcome).resolves.toBe("stored");

    const next = startCanvasProbes(event({ manager }), {}, dependencies);
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalledTimes(2));
    release();
    await expect(next.outcome).resolves.toBe("stored");
    await expect(
      startCanvasProbes(event({ manager }), {}, dependencies).outcome,
    ).resolves.toBe("not-due");
  });

  it("releases the connection when the connection-bound probes are done", async () => {
    const dependencies = deps();
    const handle = startCanvasProbes(event({ hosted: true }), {}, dependencies);
    let released = false;
    void handle.connectionReleased.then(() => {
      released = true;
    });
    await vi.waitFor(() => expect(mocks.runServerProbes).toHaveBeenCalled());
    expect(released).toBe(false);
    release();
    await handle.connectionReleased;
    expect(released).toBe(true);
    await handle.done;
  });
});
