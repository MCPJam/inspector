import { describe, expect, it, vi } from "vitest";
import type { MrtrLegResult, MrtrOperationState } from "@mcpjam/sdk";
import {
  MrtrSuspendedSignal,
  buildInputRequestDisplays,
  computeMrtrBindingFingerprint,
  createHostedMrtrCollector,
  deriveServerConfigDigest,
  isMrtrSuspendedSignal,
  resolveMrtrAuthPrincipal,
  resumeMrtrContinuationLeg,
  settleMrtrTeardown,
} from "../mrtr-hosted-collector";
import {
  encodeResumeState,
  type ClaimedContinuationState,
} from "../mrtr-continuation-state";
import type { MrtrContinuationEvent } from "@/shared/mrtr-continuation";

const SECRET = "OPAQUE_REQUEST_STATE_DO_NOT_LEAK";

function pending(): MrtrOperationState["pendingInputRequests"] {
  return {
    q1: {
      method: "elicitation/create",
      params: { mode: "form", message: "Your name?", requestedSchema: { type: "object" } },
    },
  } as unknown as MrtrOperationState["pendingInputRequests"];
}

function makeState(overrides: Partial<MrtrOperationState> = {}): MrtrOperationState {
  return {
    opId: "op-1",
    method: "tools/call",
    originalParams: { name: "do_thing", arguments: {} },
    round: 0,
    maxRounds: 10,
    requestState: SECRET,
    pendingInputRequests: pending(),
    ...overrides,
  };
}

describe("buildInputRequestDisplays", () => {
  it("scrubs to a safe display and drops non-elicitation methods", () => {
    const displays = buildInputRequestDisplays({
      q1: {
        method: "elicitation/create",
        params: { mode: "form", message: "Name?", requestedSchema: { type: "object" } },
      },
      q2: {
        method: "elicitation/create",
        params: { mode: "url", message: "Authorize", url: "https://x.test/a" },
      },
      // Should never reach here (driver rejects), but defended anyway.
      q3: { method: "sampling/createMessage", params: {} },
    } as never);
    expect(displays).toHaveLength(2);
    expect(displays[0]).toEqual({
      key: "q1",
      mode: "form",
      message: "Name?",
      requestedSchema: { type: "object" },
    });
    expect(displays[1]).toEqual({
      key: "q2",
      mode: "url",
      message: "Authorize",
      url: "https://x.test/a",
    });
  });

  it("rejects a url-mode elicitation whose scheme is not navigable", () => {
    const withUrl = (url: string) =>
      ({
        q1: { method: "elicitation/create", params: { mode: "url", message: "Go", url } },
      }) as never;
    // A hostile server must not get a script URL persisted or emitted.
    expect(() => buildInputRequestDisplays(withUrl("javascript:alert(1)"))).toThrow(
      /rejected/i,
    );
    expect(() => buildInputRequestDisplays(withUrl("data:text/html,<script>"))).toThrow(
      /rejected/i,
    );
    expect(() => buildInputRequestDisplays(withUrl(""))).toThrow(/rejected/i);
    // http(s) still passes — http for local/dev servers.
    expect(buildInputRequestDisplays(withUrl("https://x.test/a"))).toHaveLength(1);
    expect(buildInputRequestDisplays(withUrl("http://localhost:1/a"))).toHaveLength(1);
  });

  it("rejects an oversized field rather than truncating", () => {
    expect(() =>
      buildInputRequestDisplays(
        {
          q1: {
            method: "elicitation/create",
            params: { mode: "form", message: "x".repeat(50), requestedSchema: {} },
          },
        } as never,
        16,
      ),
    ).toThrow(/over the 16-byte cap/);
  });
});

describe("computeMrtrBindingFingerprint", () => {
  it("is stable and sensitive to each input", () => {
    const base = {
      serverId: "srv-1",
      negotiatedEra: "modern",
      serverConfigDigest: "d1",
      authPrincipal: "user-1",
    };
    const fp = computeMrtrBindingFingerprint(base);
    expect(fp).toBe(computeMrtrBindingFingerprint(base));
    expect(fp).not.toBe(
      computeMrtrBindingFingerprint({ ...base, authPrincipal: "user-2" }),
    );
    expect(fp).not.toBe(
      computeMrtrBindingFingerprint({ ...base, serverConfigDigest: "d2" }),
    );
  });
});

describe("deriveServerConfigDigest", () => {
  const info = {
    protocolVersion: "2026-07-28",
    transport: "streamable-http",
    serverVersion: { name: "srv", version: "1.0" },
    serverCapabilities: { elicitation: {}, tools: { listChanged: true } },
  };
  const managerFor = (config: unknown, initInfo: unknown = info) => ({
    getInitializationInfo: () => initInfo,
    getServerConfig: () => config,
  });

  it("binds the resolved endpoint, so a server swap fails closed", () => {
    // Same implementation, same reported capabilities — a DIFFERENT endpoint.
    // Without the endpoint term these two are indistinguishable and a resume
    // would replay the original params + requestState at the new server.
    const a = deriveServerConfigDigest(
      managerFor({ url: "https://a.example.com/mcp" }),
      "srv-1",
    );
    const b = deriveServerConfigDigest(
      managerFor({ url: "https://b.example.com/mcp" }),
      "srv-1",
    );
    expect(a).not.toBe(b);
    // Path and query route too.
    expect(a).not.toBe(
      deriveServerConfigDigest(
        managerFor({ url: "https://a.example.com/mcp/v2" }),
        "srv-1",
      ),
    );
    expect(a).not.toBe(
      deriveServerConfigDigest(
        managerFor({ url: "https://a.example.com/mcp?tenant=other" }),
        "srv-1",
      ),
    );
  });

  it("does NOT bind rotating credentials, so a token refresh still resumes", () => {
    // A bearer rotating behind the same endpoint is not a server swap; binding
    // it would fail every legitimate resume that straddles a refresh.
    expect(
      deriveServerConfigDigest(
        managerFor({ url: "https://a.example.com/mcp", accessToken: "tok-1" }),
        "srv-1",
      ),
    ).toBe(
      deriveServerConfigDigest(
        managerFor({ url: "https://a.example.com/mcp", accessToken: "tok-2" }),
        "srv-1",
      ),
    );
  });

  it("is insensitive to initialize key order", () => {
    expect(
      deriveServerConfigDigest(
        managerFor(
          { url: "https://a.example.com/mcp" },
          {
            serverCapabilities: { tools: { listChanged: true }, elicitation: {} },
            serverVersion: { version: "1.0", name: "srv" },
            transport: "streamable-http",
            protocolVersion: "2026-07-28",
          },
        ),
        "srv-1",
      ),
    ).toBe(
      deriveServerConfigDigest(managerFor({ url: "https://a.example.com/mcp" }), "srv-1"),
    );
  });

  it("fails closed on hostile, unboundedly nested initialize metadata", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 200; i++) {
      const next: Record<string, unknown> = {};
      deep.nested = next;
      deep = next;
    }
    expect(() =>
      deriveServerConfigDigest(
        managerFor(
          { url: "https://a.example.com/mcp" },
          { ...info, serverCapabilities: root },
        ),
        "srv-1",
      ),
    ).toThrow(/exceeded the 24-level nesting limit/);
  });

  it("fails closed on an oversized (wide) capabilities blob", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = i;
    expect(() =>
      deriveServerConfigDigest(
        managerFor(
          { url: "https://a.example.com/mcp" },
          { ...info, serverCapabilities: wide },
        ),
        "srv-1",
      ),
    ).toThrow(/exceeded the 4096-node traversal limit/);
  });
});

describe("resolveMrtrAuthPrincipal", () => {
  const ctx = (vars: Record<string, string>) => ({
    get: (k: string) => vars[k],
  });

  it("resolves the real signed-in principal, not a shared anonymous", () => {
    // `bearer-auth` sets mcpjamUserId/workosUserId — never `userId`. Reading a
    // non-existent var would resolve every signed-in caller to "anonymous" and
    // fail their resume closed against the suspend-time fingerprint.
    expect(resolveMrtrAuthPrincipal(ctx({ mcpjamUserId: "u-1" }))).toBe("u-1");
    expect(resolveMrtrAuthPrincipal(ctx({ workosUserId: "w-1" }))).toBe("w-1");
    expect(resolveMrtrAuthPrincipal(ctx({ guestId: "g-1" }))).toBe("g-1");
    expect(resolveMrtrAuthPrincipal(ctx({ userId: "u-1" }))).toBe("anonymous");
    expect(resolveMrtrAuthPrincipal(ctx({}))).toBe("anonymous");
  });
});

describe("settleMrtrTeardown", () => {
  it("returns normally on a clean disconnect", async () => {
    const disconnect = vi.fn(async () => {});
    await expect(settleMrtrTeardown(disconnect, "[t]")).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejection so cleanup cannot replace the outcome", async () => {
    await expect(
      settleMrtrTeardown(async () => {
        throw new Error("teardown exploded");
      }, "[t]"),
    ).resolves.toBeUndefined();
  });

  it("swallows a synchronous throw too", async () => {
    await expect(
      settleMrtrTeardown(() => {
        throw new Error("threw before returning a promise");
      }, "[t]"),
    ).resolves.toBeUndefined();
  });

  it("gives up on a disconnect that never settles", async () => {
    // The route's `finally` must not hold the response hostage to a transport
    // that never finishes closing: the outcome is already determined.
    let settled = false;
    const promise = settleMrtrTeardown(
      () => new Promise<void>(() => {}),
      "[t]",
      5,
    ).then(() => {
      settled = true;
    });
    await promise;
    expect(settled).toBe(true);
  });

  it("does not leave an unhandled rejection when the timeout wins first", async () => {
    // The `.catch` must sit on the teardown promise itself, not on the race —
    // otherwise a late rejection escapes after the bound has already resolved.
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      await settleMrtrTeardown(
        () =>
          new Promise<void>((_resolve, reject) =>
            setTimeout(() => reject(new Error("late failure")), 15),
          ),
        "[t]",
        5,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("hosted MRTR collector (suspend, do not block)", () => {
  it("persists, emits a scrubbed part, and throws MrtrSuspendedSignal", async () => {
    const events: MrtrContinuationEvent[] = [];
    const create = vi.fn(async () => ({
      ok: true as const,
      continuationId: "cont-1",
      status: "awaiting_input" as const,
      round: 0,
      stateVersion: 1,
      expiresAt: 1_000,
      createdAt: 0,
      idempotent: false,
    }));

    const collector = createHostedMrtrCollector({
      bearer: "b",
      projectId: "proj-1",
      serverId: "srv-1",
      serverName: "GitHub",
      negotiatedEra: "modern",
      bindingFingerprint: "fp",
      emit: (e) => events.push(e),
      create: create as never,
      mintId: () => "cont-1",
    });

    const state = makeState();
    // Resolves quickly by THROWING — it never blocks/polls for a human answer.
    await expect(
      collector({ state, inputRequests: state.pendingInputRequests }),
    ).rejects.toBeInstanceOf(MrtrSuspendedSignal);

    // Persisted with the encoded (opaque) state.
    expect(create).toHaveBeenCalledTimes(1);
    const createArgs = (create.mock.calls[0] as unknown as [unknown, { resumeState: string }])[1];
    expect(typeof createArgs.resumeState).toBe("string");

    // Emitted exactly one input_required part, and it NEVER carries the secret.
    expect(events).toHaveLength(1);
    const emitted = JSON.stringify(events[0]);
    expect(emitted).not.toContain(SECRET);
    expect(events[0]).toMatchObject({
      kind: "input_required",
      continuationId: "cont-1",
      serverId: "srv-1",
      method: "tools/call",
      operationLabel: "do_thing",
      round: 0,
    });
  });

  it("fails the operation (no emit) when the store rejects the create", async () => {
    const events: MrtrContinuationEvent[] = [];
    const create = vi.fn(async () => ({
      ok: false as const,
      status: 409,
      error: "conflict",
    }));
    const collector = createHostedMrtrCollector({
      bearer: "b",
      projectId: "proj-1",
      serverId: "srv-1",
      negotiatedEra: "modern",
      bindingFingerprint: "fp",
      emit: (e) => events.push(e),
      create: create as never,
      mintId: () => "cont-1",
    });
    const state = makeState();
    await expect(
      collector({ state, inputRequests: state.pendingInputRequests }),
    ).rejects.toThrow(/Failed to persist MRTR continuation/);
    // Not suspended, and nothing emitted for a record that was never created.
    expect(events).toHaveLength(0);
  });
});

/** In-memory fake of the PR3a continuation store for the resume primitive. */
function makeFakeStore(seed: {
  continuationId: string;
  state: MrtrOperationState;
  sideEffecting?: boolean;
  bindingFingerprint?: string;
  round?: number;
  expiresAt?: number;
  /** Inject a store-write failure to exercise the post-wire outcome mapping. */
  failFinalize?: { status: number; error: string };
  failResuspend?: { status: number; error: string };
}) {
  let stateVersion = 1;
  let attempt = 0;
  const submitted = new Map<number, boolean>();
  const calls = {
    claim: 0,
    submit: 0,
    markWireStarted: 0,
    finalize: [] as string[],
    resuspend: [] as number[],
    cancel: [] as string[],
    release: 0,
  };
  const claimedState: ClaimedContinuationState = {
    continuationId: seed.continuationId,
    serverId: "srv-1",
    operationId: seed.state.opId,
    operationMethod: "tools/call",
    sideEffecting: seed.sideEffecting ?? false,
    negotiatedEra: "modern",
    projectId: "proj-1",
    resumeState: encodeResumeState(seed.state),
    round: seed.round ?? seed.state.round,
    maxRounds: seed.state.maxRounds,
    attempt: 0,
    ...(seed.expiresAt !== undefined ? { expiresAt: seed.expiresAt } : {}),
  };

  return {
    calls,
    deps: {
      claim: (async (_bearer: string, args: { bindingFingerprint: string }) => {
        calls.claim += 1;
        if (
          seed.bindingFingerprint &&
          args.bindingFingerprint !== seed.bindingFingerprint
        ) {
          return { ok: false as const, status: 409, error: "binding mismatch" };
        }
        return {
          ok: true as const,
          state: claimedState,
          status: "resuming" as const,
          stateVersion,
        };
      }) as never,
      submitResponse: (async (_bearer: string, args: { round: number }) => {
        calls.submit += 1;
        const idempotent = submitted.has(args.round);
        submitted.set(args.round, true);
        stateVersion += idempotent ? 0 : 1;
        return { ok: true as const, idempotent, stateVersion };
      }) as never,
      markWireStarted: (async () => {
        calls.markWireStarted += 1;
        attempt += 1;
        return { ok: true as const, attempt };
      }) as never,
      resuspend: (async (_bearer: string, args: { round: number }) => {
        calls.resuspend.push(args.round);
        if (seed.failResuspend) {
          return { ok: false as const, ...seed.failResuspend };
        }
        stateVersion += 1;
        return {
          ok: true as const,
          status: "awaiting_input" as const,
          round: args.round,
          stateVersion,
          expiresAt: 2_000,
        };
      }) as never,
      finalize: (async (_bearer: string, args: { status: string }) => {
        calls.finalize.push(args.status);
        if (seed.failFinalize) {
          return { ok: false as const, ...seed.failFinalize };
        }
        stateVersion += 1;
        return { ok: true as const, stateVersion, status: args.status };
      }) as never,
      release: (async () => {
        calls.release += 1;
        return { ok: true as const, status: "awaiting_input" as const };
      }) as never,
      cancel: (async (_bearer: string, args: { reason?: string }) => {
        calls.cancel.push(args.reason ?? "");
        return { ok: true as const, status: "indeterminate" as const };
      }) as never,
    },
  };
}

describe("resumeMrtrContinuationLeg", () => {
  const submission = {
    continuationId: "cont-1",
    round: 0,
    responses: { q1: { action: "accept" as const, content: { name: "Ada" } } },
  };

  it("claims, submits, drives one leg, and finalizes on a complete result", async () => {
    const store = makeFakeStore({ continuationId: "cont-1", state: makeState() });
    const driveLeg = vi.fn(
      async (): Promise<MrtrLegResult<unknown>> => ({
        status: "complete",
        result: { content: [{ type: "text", text: "done" }] },
      }),
    );
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "fp",
      driveLeg,
      ...store.deps,
    });
    expect(outcome.outcome).toBe("completed");
    expect(store.calls.claim).toBe(1);
    expect(store.calls.submit).toBe(1);
    expect(store.calls.finalize).toEqual(["completed"]);
    expect(driveLeg).toHaveBeenCalledTimes(1);
  });

  it("is idempotent for a duplicate submission of the same round", async () => {
    const store = makeFakeStore({ continuationId: "cont-1", state: makeState() });
    const driveLeg = async (): Promise<MrtrLegResult<unknown>> => ({
      status: "complete",
      result: { ok: true },
    });
    const first = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "fp",
      driveLeg,
      ...store.deps,
    });
    const second = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "fp",
      driveLeg,
      ...store.deps,
    });
    expect(first.outcome).toBe("completed");
    expect(second.outcome).toBe("completed");
    // The second submit reports idempotent (no duplicate side effect recorded).
    expect(store.calls.submit).toBe(2);
  });

  it("re-suspends on another input_required round with a scrubbed display", async () => {
    const store = makeFakeStore({ continuationId: "cont-1", state: makeState() });
    const nextState = makeState({
      round: 1,
      pendingInputRequests: {
        q2: {
          method: "elicitation/create",
          params: { mode: "form", message: "Confirm?", requestedSchema: { type: "object" } },
        },
      } as unknown as MrtrOperationState["pendingInputRequests"],
    });
    const emitted: MrtrContinuationEvent[] = [];
    const driveLeg = async (): Promise<MrtrLegResult<unknown>> => ({
      status: "input_required",
      state: nextState,
    });
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "fp",
      driveLeg,
      emit: (e) => emitted.push(e),
      ...store.deps,
    });
    expect(outcome).toMatchObject({ outcome: "input_required", round: 1 });
    expect(store.calls.resuspend).toEqual([1]);
    expect(store.calls.finalize).toEqual([]);
    const evt = emitted.find((e) => e.kind === "input_required");
    expect(JSON.stringify(evt)).not.toContain(SECRET);
  });

  it("fails closed on a binding-fingerprint mismatch (claim 409)", async () => {
    const store = makeFakeStore({
      continuationId: "cont-1",
      state: makeState(),
      bindingFingerprint: "correct-fp",
    });
    const driveLeg = vi.fn();
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "WRONG-fp",
      driveLeg: driveLeg as never,
      ...store.deps,
    });
    expect(outcome).toMatchObject({ outcome: "cancelled", status: 409 });
    expect(driveLeg).not.toHaveBeenCalled();
  });

  it("transitions a side-effecting op to indeterminate when the leg throws", async () => {
    const store = makeFakeStore({
      continuationId: "cont-1",
      state: makeState(),
      sideEffecting: true,
    });
    const driveLeg = async (): Promise<MrtrLegResult<unknown>> => {
      throw new Error("worker crashed mid-wire");
    };
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "fp",
      driveLeg,
      ...store.deps,
    });
    expect(outcome.outcome).toBe("indeterminate");
    // The exactly-once fence was set before the wire, and cancel (not a silent
    // replay) drove the terminal transition.
    expect(store.calls.markWireStarted).toBe(1);
    expect(store.calls.cancel).toHaveLength(1);
    expect(store.calls.finalize).toEqual([]);
  });

  it("rejects a stale-round submission", async () => {
    const store = makeFakeStore({
      continuationId: "cont-1",
      state: makeState({ round: 3 }),
      round: 3,
    });
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission: { ...submission, round: 0 },
      bindingFingerprint: "fp",
      driveLeg: (async () => ({ status: "complete", result: {} })) as never,
      ...store.deps,
    });
    expect(outcome).toMatchObject({ outcome: "failed", status: 409 });
    expect(store.calls.release).toBe(1);
  });

  it("replays the current round when the browser retries the round before it", async () => {
    // The store advanced to round 1 (a resuspend the browser never saw); the
    // browser can only retry round 0. That must re-serve round 1, not strand the
    // continuation until its TTL.
    const store = makeFakeStore({
      continuationId: "cont-1",
      state: makeState({ round: 1 }),
      round: 1,
      expiresAt: 9_000,
    });
    const driveLeg = vi.fn();
    const emitted: MrtrContinuationEvent[] = [];
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission: { ...submission, round: 0 },
      bindingFingerprint: "fp",
      driveLeg: driveLeg as never,
      emit: (e) => emitted.push(e),
      ...store.deps,
    });
    expect(outcome).toMatchObject({
      outcome: "input_required",
      round: 1,
      expiresAt: 9_000,
    });
    // Read-only recovery: no leg, no submit, no write — just the lease released.
    expect(driveLeg).not.toHaveBeenCalled();
    expect(store.calls.submit).toBe(0);
    expect(store.calls.resuspend).toEqual([]);
    expect(store.calls.finalize).toEqual([]);
    expect(store.calls.release).toBe(1);
    const evt = emitted.find((e) => e.kind === "input_required");
    expect(evt).toBeDefined();
    expect(JSON.stringify(evt)).not.toContain(SECRET);
  });

  it("omits expiresAt on a replay when the claim payload carries no deadline", async () => {
    // Absence must read as "unknown", never as an invented/expired deadline.
    const store = makeFakeStore({
      continuationId: "cont-1",
      state: makeState({ round: 1 }),
      round: 1,
    });
    const emitted: MrtrContinuationEvent[] = [];
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission: { ...submission, round: 0 },
      bindingFingerprint: "fp",
      driveLeg: (async () => ({ status: "complete", result: {} })) as never,
      emit: (e) => emitted.push(e),
      ...store.deps,
    });
    expect(outcome).toMatchObject({ outcome: "input_required", round: 1 });
    expect(outcome).not.toHaveProperty("expiresAt");
    // No fabricated deadline reaches the browser event either.
    expect(emitted.find((e) => e.kind === "input_required")).toBeUndefined();
  });

  it("reports indeterminate when finalize fails after a completed side-effecting leg", async () => {
    const store = makeFakeStore({
      continuationId: "cont-1",
      state: makeState(),
      sideEffecting: true,
      failFinalize: { status: 409, error: "lease expired" },
    });
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "fp",
      driveLeg: async (): Promise<MrtrLegResult<unknown>> => ({
        status: "complete",
        result: { ok: true },
      }),
      ...store.deps,
    });
    // The tool definitively ran; a durability failure must NOT read as
    // `cancelled`/`failed`, which would invite a double-executing retry.
    expect(outcome).toMatchObject({ outcome: "indeterminate", result: { ok: true } });
    expect(store.calls.cancel).toHaveLength(1);
  });

  it("reports indeterminate when resuspend fails after a side-effecting leg", async () => {
    const store = makeFakeStore({
      continuationId: "cont-1",
      state: makeState(),
      sideEffecting: true,
      failResuspend: { status: 409, error: "version conflict" },
    });
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "fp",
      driveLeg: async (): Promise<MrtrLegResult<unknown>> => ({
        status: "input_required",
        state: makeState({ round: 1 }),
      }),
      ...store.deps,
    });
    expect(outcome.outcome).toBe("indeterminate");
    expect(store.calls.cancel).toHaveLength(1);
  });

  it("reports indeterminate when the next round's state cannot be encoded after a side-effecting leg", async () => {
    // The store write would SUCCEED here — the failure is ours (the next state
    // will not encode). The wire still left, so a durable `failed` would invite
    // a restart of something that may have executed.
    const store = makeFakeStore({
      continuationId: "cont-1",
      state: makeState(),
      sideEffecting: true,
    });
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "fp",
      driveLeg: async (): Promise<MrtrLegResult<unknown>> => ({
        status: "input_required",
        state: makeState({ round: 1 }),
      }),
      encode: (() => {
        throw new Error("resumeState too large");
      }) as never,
      ...store.deps,
    });
    expect(outcome.outcome).toBe("indeterminate");
    // Marked indeterminate, NOT durably finalized as failed.
    expect(store.calls.cancel).toHaveLength(1);
    expect(store.calls.finalize).toEqual([]);
  });

  it("still finalizes failed on an encode error for a NON-side-effecting op", async () => {
    const store = makeFakeStore({
      continuationId: "cont-1",
      state: makeState(),
      sideEffecting: false,
    });
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "fp",
      driveLeg: async (): Promise<MrtrLegResult<unknown>> => ({
        status: "input_required",
        state: makeState({ round: 1 }),
      }),
      encode: (() => {
        throw new Error("resumeState too large");
      }) as never,
      ...store.deps,
    });
    // Nothing side-effecting happened, so the precise terminal reason is kept.
    expect(outcome.outcome).toBe("failed");
    expect(store.calls.finalize).toEqual(["failed"]);
    expect(store.calls.cancel).toHaveLength(0);
  });

  it("keeps the ordinary mapping when a store write fails on a NON-side-effecting op", async () => {
    // Nothing side-effecting left the wire, so this is safely replayable and
    // must stay `cancelled`/`failed` rather than being escalated.
    const store = makeFakeStore({
      continuationId: "cont-1",
      state: makeState(),
      sideEffecting: false,
      failFinalize: { status: 409, error: "version conflict" },
    });
    const outcome = await resumeMrtrContinuationLeg({
      bearer: "b",
      submission,
      bindingFingerprint: "fp",
      driveLeg: async (): Promise<MrtrLegResult<unknown>> => ({
        status: "complete",
        result: { ok: true },
      }),
      ...store.deps,
    });
    expect(outcome).toMatchObject({ outcome: "cancelled", status: 409 });
    expect(store.calls.cancel).toHaveLength(0);
  });
});

describe("isMrtrSuspendedSignal", () => {
  it("recognizes the signal by instance and by code", () => {
    expect(isMrtrSuspendedSignal(new MrtrSuspendedSignal("c", 0))).toBe(true);
    expect(isMrtrSuspendedSignal({ code: "MRTR_SUSPENDED" })).toBe(true);
    expect(isMrtrSuspendedSignal(new Error("nope"))).toBe(false);
  });
});
