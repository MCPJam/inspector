import { describe, expect, it, vi } from "vitest";
import type { MrtrLegResult, MrtrOperationState } from "@mcpjam/sdk";
import {
  MrtrSuspendedSignal,
  buildInputRequestDisplays,
  computeMrtrBindingFingerprint,
  createHostedMrtrCollector,
  isMrtrSuspendedSignal,
  resumeMrtrContinuationLeg,
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
});

describe("isMrtrSuspendedSignal", () => {
  it("recognizes the signal by instance and by code", () => {
    expect(isMrtrSuspendedSignal(new MrtrSuspendedSignal("c", 0))).toBe(true);
    expect(isMrtrSuspendedSignal({ code: "MRTR_SUSPENDED" })).toBe(true);
    expect(isMrtrSuspendedSignal(new Error("nope"))).toBe(false);
  });
});
