/**
 * The transport, against a stubbed `fetch`.
 *
 * The pass tests drive injected ports, so this module is never executed there
 * — and it holds decisions nothing else can make: 404 means the feature is off
 * rather than broken, `retry` splits "a row was consumed" from "the queue is
 * empty", a payload that fails the narrowing checks is an error rather than a
 * half-built claim, and the request deadline has to survive the body read.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyStageDerivation,
  chatStageWorkerConfigured,
  claimNextStageDerivation,
  failStageDerivation,
  ChatStageBackendError,
} from "../chat-session-stage-backend.js";

const CLAIM = {
  ok: true,
  claimed: true,
  sessionDocId: "sess-1",
  chatSessionId: "external-1",
  generation: 7,
  source: "user_testing",
  sourceStamp: { sessionVersion: 3, messageCount: 4 },
  attempts: 1,
  evidence: { lifecycle: "settled" },
  envelope: { messages: [] },
};

function stubFetch(
  responder: (url: string, init: any) => { status: number; body?: unknown },
) {
  const calls: Array<{ path: string; body: any; headers: any; signal: any }> =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      calls.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body),
        headers: init.headers,
        signal: init.signal,
      });
      const { status, body } = responder(url, init);
      return {
        status,
        json: async () => {
          if (body === undefined) throw new Error("no body");
          return body;
        },
      } as unknown as Response;
    }),
  );
  return calls;
}

function configured() {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("being a worker peer at all", () => {
  it("is false without the service-token env", () => {
    vi.stubEnv("CONVEX_HTTP_URL", "");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    expect(chatStageWorkerConfigured()).toBe(false);
  });

  it("is true with both", () => {
    configured();
    expect(chatStageWorkerConfigured()).toBe(true);
  });

  it("refuses to call the backend when unconfigured", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    await expect(claimNextStageDerivation("w1")).rejects.toThrow(
      /CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN/,
    );
  });
});

describe("claim", () => {
  it("sends the service token and the worker id", async () => {
    configured();
    const calls = stubFetch(() => ({ status: 200, body: CLAIM }));
    await claimNextStageDerivation("worker-9");
    expect(calls[0].path).toBe("/internal/v1/chat-stage-derivations/claim");
    expect(calls[0].headers["x-inspector-service-token"]).toBe("service-token");
    expect(calls[0].body).toEqual({ claimedBy: "worker-9" });
  });

  it("returns the claim, carrying the stamp verbatim", async () => {
    configured();
    stubFetch(() => ({ status: 200, body: CLAIM }));
    const outcome = await claimNextStageDerivation("w1");
    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") return;
    expect(outcome.claim.sourceStamp).toEqual(CLAIM.sourceStamp);
    expect(outcome.claim.generation).toBe(7);
  });

  it("reads a 404 as the feature being OFF, not as an error", async () => {
    configured();
    stubFetch(() => ({ status: 404, body: { ok: false } }));
    expect(await claimNextStageDerivation("w1")).toEqual({ kind: "disabled" });
  });

  it("splits `drained` from `empty` on the retry flag", async () => {
    configured();
    stubFetch(() => ({
      status: 200,
      body: { ok: true, claimed: false, retry: true },
    }));
    expect(await claimNextStageDerivation("w1")).toEqual({ kind: "drained" });

    vi.unstubAllGlobals();
    stubFetch(() => ({
      status: 200,
      body: { ok: true, claimed: false, retry: false },
    }));
    expect(await claimNextStageDerivation("w1")).toEqual({ kind: "empty" });
  });

  it("throws on a non-200", async () => {
    configured();
    stubFetch(() => ({ status: 500, body: { ok: false } }));
    await expect(claimNextStageDerivation("w1")).rejects.toBeInstanceOf(
      ChatStageBackendError,
    );
  });

  it("throws on `ok: false` even at 200", async () => {
    configured();
    stubFetch(() => ({ status: 200, body: { ok: false } }));
    await expect(claimNextStageDerivation("w1")).rejects.toBeInstanceOf(
      ChatStageBackendError,
    );
  });

  it("throws on an unparseable body rather than inventing a claim", async () => {
    configured();
    stubFetch(() => ({ status: 200, body: undefined }));
    await expect(claimNextStageDerivation("w1")).rejects.toBeInstanceOf(
      ChatStageBackendError,
    );
  });

  it.each([
    ["a missing sessionDocId", { ...CLAIM, sessionDocId: undefined }],
    ["a non-numeric generation", { ...CLAIM, generation: "7" }],
    ["a missing source", { ...CLAIM, source: undefined }],
    ["a null sourceStamp", { ...CLAIM, sourceStamp: null }],
  ])("refuses %s", async (_label, body) => {
    configured();
    stubFetch(() => ({ status: 200, body }));
    await expect(claimNextStageDerivation("w1")).rejects.toThrow(
      /malformed payload/,
    );
  });

  it("tolerates the genuinely optional fields being absent", async () => {
    configured();
    stubFetch(() => ({
      status: 200,
      body: {
        ok: true,
        claimed: true,
        sessionDocId: "sess-1",
        generation: 1,
        attempts: 2,
        source: "swarm",
        sourceStamp: {},
      },
    }));
    const outcome = await claimNextStageDerivation("w1");
    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") return;
    expect(outcome.claim.chatSessionId).toBe("");
    expect(outcome.claim.attempts).toBe(2);
    expect(outcome.claim.evidence).toEqual({});
    expect(outcome.claim.envelope).toBeNull();
  });

  it("REFUSES a claim with no attempts — that is the claim's identity", async () => {
    // Defaulting it would manufacture credentials for a claim we cannot prove
    // we hold, and the backend's apply guard reads exactly this to decide
    // whether we still own the row.
    configured();
    stubFetch(() => ({
      status: 200,
      body: {
        ok: true,
        claimed: true,
        sessionDocId: "sess-1",
        generation: 1,
        source: "swarm",
        sourceStamp: {},
      },
    }));
    await expect(claimNextStageDerivation("w1")).rejects.toThrow(
      /malformed payload/,
    );
  });
});

describe("apply", () => {
  const args = {
    sessionDocId: "sess-1",
    generation: 7,
    sourceStamp: { sessionVersion: 3 },
    stageResults: [],
    stageAnalyzerVersion: 5,
  };

  it("reports applied", async () => {
    configured();
    stubFetch(() => ({ status: 200, body: { ok: true, applied: true } }));
    expect(await applyStageDerivation(args)).toEqual({ kind: "applied" });
  });

  it("distinguishes superseded from invalid", async () => {
    configured();
    stubFetch(() => ({
      status: 200,
      body: {
        ok: true,
        applied: false,
        outcome: "superseded",
        reason: "generation 7 superseded by 8",
      },
    }));
    expect(await applyStageDerivation(args)).toEqual({
      kind: "superseded",
      reason: "generation 7 superseded by 8",
    });

    vi.unstubAllGlobals();
    stubFetch(() => ({
      status: 200,
      body: {
        ok: true,
        applied: false,
        outcome: "invalid",
        reason: "expected 6 stage rows",
      },
    }));
    expect(await applyStageDerivation(args)).toEqual({
      kind: "invalid",
      reason: "expected 6 stage rows",
    });
  });

  it("throws on a non-200 so the pass can record one row's failure", async () => {
    configured();
    stubFetch(() => ({ status: 502, body: { ok: false } }));
    await expect(applyStageDerivation(args)).rejects.toBeInstanceOf(
      ChatStageBackendError,
    );
  });
});

describe("fail", () => {
  it("posts the closed error code", async () => {
    configured();
    const calls = stubFetch(() => ({ status: 200, body: { ok: true } }));
    await failStageDerivation({
      sessionDocId: "sess-1",
      generation: 7,
      errorCode: "evidence_unavailable",
      retryable: true,
    });
    expect(calls[0].path).toBe("/internal/v1/chat-stage-derivations/fail");
    expect(calls[0].body).toEqual({
      sessionDocId: "sess-1",
      generation: 7,
      errorCode: "evidence_unavailable",
      retryable: true,
    });
  });

  it("swallows a transport failure — the lease is what re-offers the row", async () => {
    configured();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset");
      }),
    );
    await expect(
      failStageDerivation({
        sessionDocId: "sess-1",
        generation: 7,
        errorCode: "worker_error",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("the request deadline covers the body, not just the headers", () => {
  it("keeps the abort signal live while the body is read", async () => {
    configured();
    // `fetch` resolves as soon as the headers land. A body that never
    // arrives must still be aborted, or a stalled deployment holds the pass
    // open forever — the wedge the cap exists to prevent.
    let signalDuringBodyRead: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => ({
        status: 200,
        json: async () => {
          signalDuringBodyRead = init.signal;
          // The timer must not have been cleared before we got here.
          expect(init.signal.aborted).toBe(false);
          return { ok: true, claimed: false, retry: false };
        },
      })) as never,
    );
    await claimNextStageDerivation("w1");
    expect(signalDuringBodyRead).toBeDefined();
  });
});
