import { describe, expect, it, vi } from "vitest";
import type { MrtrOperationState } from "@mcpjam/sdk";
import {
  resolveHostedMrtrGate,
  runHostedDirectMrtrOperation,
  type HostedDirectMrtrSeams,
} from "../mrtr-direct";
import { HOSTED_MRTR_VERSION } from "@/shared/mrtr-continuation";

const SECRET = "OPAQUE_REQUEST_STATE_DO_NOT_LEAK";

function makeState(overrides: Partial<MrtrOperationState> = {}): MrtrOperationState {
  return {
    opId: "op-1",
    method: "tools/call",
    originalParams: { name: "do_thing", arguments: {} },
    round: 0,
    maxRounds: 10,
    requestState: SECRET,
    pendingInputRequests: {
      q1: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Your name?",
          requestedSchema: { type: "object" },
        },
      },
    } as unknown as MrtrOperationState["pendingInputRequests"],
    ...overrides,
  };
}

/** A minimal Hono-like context capturing the JSON response. */
function makeCtx(body: Record<string, unknown>, getters: Record<string, string> = {}) {
  const captured: { payload?: unknown; status?: number } = {};
  return {
    ctx: {
      get: (k: string) => getters[k],
      req: { json: async () => body },
      json: (payload: unknown, status: number) => {
        captured.payload = payload;
        captured.status = status;
        return { payload, status };
      },
    },
    captured,
  };
}

/** Fake `createContinuation` that always accepts and echoes the id/round. */
const fakeCreate: NonNullable<HostedDirectMrtrSeams["createContinuation"]> = (async (
  _bearer: string,
  b: { continuationId: string; round?: number },
) => ({
  ok: true as const,
  continuationId: b.continuationId,
  status: "awaiting_input" as const,
  round: b.round ?? 0,
  stateVersion: 1,
  expiresAt: 5_000,
  createdAt: 0,
  idempotent: false,
})) as never;

/**
 * Fake connection: mimics `createAuthorizedManager` registering the collector
 * synchronously, and hands back a manager whose negotiated identity is fixed so
 * the binding fingerprint is deterministic.
 */
function makeFakeConnect() {
  const disconnect = vi.fn(async () => {});
  let seenCollectorFactory:
    | ((serverId: string) => unknown | undefined)
    | undefined;
  const connect = (async (
    _c: unknown,
    rawBody: Record<string, unknown>,
    _schema: unknown,
    opts?: {
      mrtrInputCollectorForServer?: (serverId: string) => unknown | undefined;
    },
  ) => {
    seenCollectorFactory = opts?.mrtrInputCollectorForServer;
    const collector = opts?.mrtrInputCollectorForServer?.(
      rawBody.serverId as string,
    );
    const manager = {
      __collector: collector,
      getInitializationInfo: () => ({
        protocolVersion: "2026-07-28",
        transport: "streamable-http",
        serverVersion: { name: "srv", version: "1.0" },
        serverCapabilities: { elicitation: {} },
      }),
      setPerRequestLogLevel: () => {},
      disconnectAllServers: disconnect,
    };
    return { manager, body: rawBody, convexAuthToken: "tok" };
  }) as never;
  return {
    connect,
    disconnect,
    factorySeen: () => seenCollectorFactory,
  };
}

const seams = (connect: HostedDirectMrtrSeams["connect"]): HostedDirectMrtrSeams => ({
  connect,
  getBearer: async () => "bearer-xyz",
  createContinuation: fakeCreate,
  mintContinuationId: () => "cont-42",
});

describe("resolveHostedMrtrGate", () => {
  it("is disabled when no version is declared (backwards compatible)", () => {
    expect(resolveHostedMrtrGate({})).toBe(false);
    expect(resolveHostedMrtrGate({ hostedMrtrVersion: undefined })).toBe(false);
  });

  it("is enabled for the compatible version", () => {
    expect(resolveHostedMrtrGate({ hostedMrtrVersion: HOSTED_MRTR_VERSION })).toBe(
      true,
    );
  });

  it("fails fast (409) for a stale/incompatible version", () => {
    expect(() =>
      resolveHostedMrtrGate({ hostedMrtrVersion: HOSTED_MRTR_VERSION + 1 }),
    ).toThrow(/outdated hosted client/);
    // A non-numeric version is also stale, not silently ignored.
    expect(() =>
      resolveHostedMrtrGate({ hostedMrtrVersion: "v1" }),
    ).toThrow(/outdated hosted client/);
  });
});

describe("runHostedDirectMrtrOperation — suspend", () => {
  it("returns a pending outcome without blocking and never leaks requestState", async () => {
    const fake = makeFakeConnect();
    const { ctx, captured } = makeCtx(
      {
        projectId: "proj-1",
        serverId: "srv-1",
        serverName: "GitHub",
        toolName: "do_thing",
        parameters: {},
        hostedMrtrVersion: HOSTED_MRTR_VERSION,
      },
      { userId: "user-1" },
    );

    // The verb simulates the SDK invoking the registered collector on an
    // `input_required` result — which SUSPENDS by throwing.
    const runVerb = async (manager: any) => {
      const collector = manager.__collector;
      const state = makeState();
      return collector({ state, inputRequests: state.pendingInputRequests });
    };

    await runHostedDirectMrtrOperation(
      ctx as never,
      {} as never,
      { method: "tools/call" },
      runVerb,
      { rpcLogs: false, seams: seams(fake.connect) },
    );

    expect(captured.status).toBe(200);
    const payload = captured.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: "input_required",
      continuationId: "cont-42",
      serverId: "srv-1",
      serverName: "GitHub",
      method: "tools/call",
      operationLabel: "do_thing",
      round: 0,
      // Echoed back to /resume; part of the binding fingerprint.
      negotiatedEra: "2026-07-28",
      version: HOSTED_MRTR_VERSION,
    });
    expect(Array.isArray(payload.inputRequests)).toBe(true);
    expect((payload.inputRequests as unknown[]).length).toBe(1);
    // The opaque requestState never reaches the browser.
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    // The worker returned + cleaned up (did not block on a human).
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("runHostedDirectMrtrOperation — completed", () => {
  it("returns the verb result verbatim when the op does not suspend", async () => {
    const fake = makeFakeConnect();
    const { ctx, captured } = makeCtx({
      projectId: "proj-1",
      serverId: "srv-1",
      toolName: "do_thing",
      parameters: {},
      hostedMrtrVersion: HOSTED_MRTR_VERSION,
    });

    const result = {
      status: "completed" as const,
      result: { content: [{ type: "text", text: "done" }] },
    };
    const runVerb = async () => result;

    await runHostedDirectMrtrOperation(
      ctx as never,
      {} as never,
      { method: "tools/call" },
      runVerb,
      { rpcLogs: false, seams: seams(fake.connect) },
    );

    expect(captured.status).toBe(200);
    // Verbatim — the completed shape is unchanged from the pre-MRTR route.
    expect(captured.payload).toEqual(result);
  });

  it("does NOT inject a collector when the request omits the version", async () => {
    const fake = makeFakeConnect();
    const { ctx, captured } = makeCtx({
      projectId: "proj-1",
      serverId: "srv-1",
      uri: "res://x",
      // no hostedMrtrVersion → non-MRTR path
    });

    const runVerb = async (manager: any) => {
      // Collector must be absent on the non-MRTR path.
      expect(manager.__collector).toBeUndefined();
      return { content: { ok: true } };
    };

    await runHostedDirectMrtrOperation(
      ctx as never,
      {} as never,
      { method: "resources/read" },
      runVerb,
      { rpcLogs: false, seams: seams(fake.connect) },
    );

    expect(captured.status).toBe(200);
    expect(fake.factorySeen()).toBeUndefined();
    expect(captured.payload).toEqual({ content: { ok: true } });
  });
});

describe("runHostedDirectMrtrOperation — stale browser fails fast", () => {
  it("responds 409 and never connects", async () => {
    const fake = makeFakeConnect();
    const connectSpy = vi.fn(fake.connect as never);
    const { ctx, captured } = makeCtx({
      projectId: "proj-1",
      serverId: "srv-1",
      toolName: "do_thing",
      parameters: {},
      hostedMrtrVersion: HOSTED_MRTR_VERSION + 1,
    });

    await runHostedDirectMrtrOperation(
      ctx as never,
      {} as never,
      { method: "tools/call" },
      async () => ({ status: "completed" as const, result: {} }),
      { rpcLogs: false, seams: seams(connectSpy as never) },
    );

    expect(captured.status).toBe(409);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(fake.disconnect).not.toHaveBeenCalled();
  });
});

describe("runHostedDirectMrtrOperation — surfaces a real verb error honestly", () => {
  it("maps a thrown verb error to a route error (not a pending outcome)", async () => {
    const fake = makeFakeConnect();
    const { ctx, captured } = makeCtx({
      projectId: "proj-1",
      serverId: "srv-1",
      toolName: "do_thing",
      parameters: {},
      hostedMrtrVersion: HOSTED_MRTR_VERSION,
    });

    await runHostedDirectMrtrOperation(
      ctx as never,
      {} as never,
      { method: "tools/call" },
      async () => {
        throw new Error("tool blew up");
      },
      { rpcLogs: false, seams: seams(fake.connect) },
    );

    // A genuine failure is not dressed up as input_required, and the connection
    // is still torn down.
    expect(captured.status).toBeGreaterThanOrEqual(400);
    const payload = captured.payload as Record<string, unknown>;
    expect(payload.status).not.toBe("input_required");
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });
});
