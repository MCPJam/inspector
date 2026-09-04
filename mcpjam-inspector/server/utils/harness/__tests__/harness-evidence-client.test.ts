/**
 * The proxy's half of the completeness protocol.
 *
 * Every test here is about one of two questions: may this tool call proceed,
 * and is the loss visible when something fails? The client's whole reason for
 * existing is that "the write failed" and "the call did not happen" are
 * different facts, and a turn's grading depends on telling them apart.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createHarnessEvidenceClient,
  evidenceSinkBreaker,
  type HarnessEvidenceTransport,
} from "../harness-evidence-client";

// The breaker is module-level state keyed by iterationId (it must survive
// across per-request client instances); tests share one scope, so each starts
// from a closed breaker.
beforeEach(() => evidenceSinkBreaker.resetForTest());

const scope = {
  runId: "run_1",
  iterationId: "iter_1",
  turnId: "turn_1",
};

/** No real waiting — the backoff is exercised by counting attempts, not time. */
const noSleep = async () => {};

function transportReturning(
  ...responses: Array<{ status: number; body?: Record<string, unknown> }>
): { transport: HarnessEvidenceTransport; calls: Array<[string, any]> } {
  const calls: Array<[string, any]> = [];
  let index = 0;
  const transport: HarnessEvidenceTransport = async (path, body) => {
    calls.push([path, body]);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return { status: response.status, body: response.body ?? null };
  };
  return { transport, calls };
}

const startCall = {
  requestId: "req_1",
  serverId: "server-1",
  toolName: "search",
  arguments: { q: "x" },
  startedAtMs: 1_000,
};

describe("recordStart", () => {
  test("acknowledges, and sends arguments as a STRING", async () => {
    const { transport, calls } = transportReturning({ status: 200 });
    const client = createHarnessEvidenceClient({ scope, transport });

    expect(await client.recordStart(startCall)).toBe(true);

    const [path, body] = calls[0];
    expect(path).toBe("start");
    expect(body).toMatchObject({
      runId: "run_1",
      iterationId: "iter_1",
      turnId: "turn_1",
      requestId: "req_1",
      serverId: "server-1",
      toolName: "search",
      startedAtMs: 1_000,
    });
    // A string, because `$`-prefixed keys are rewritten crossing the Convex
    // argument boundary and evidence that paraphrases the arguments the server
    // received is not evidence.
    expect(typeof body.argumentsJson).toBe("string");
    expect(JSON.parse(body.argumentsJson)).toEqual({ q: "x" });
    expect([...client.startedRequestIds]).toEqual(["req_1"]);
  });

  test("preserves `$schema` and lone surrogates through the string", async () => {
    const { transport, calls } = transportReturning({ status: 200 });
    const client = createHarnessEvidenceClient({ scope, transport });

    const args = { $schema: "https://x/schema.json", lone: "\ud800" };
    await client.recordStart({ ...startCall, arguments: args });

    expect(JSON.parse(calls[0][1].argumentsJson)).toEqual(args);
  });

  test("retries a transport failure, then acknowledges", async () => {
    const { transport, calls } = transportReturning(
      { status: 503 },
      { status: 200 },
    );
    const client = createHarnessEvidenceClient({
      scope,
      transport,
      sleep: noSleep,
    });

    expect(await client.recordStart(startCall)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("REFUSES the call when the budget runs out", async () => {
    const { transport, calls } = transportReturning({ status: 500 });
    const client = createHarnessEvidenceClient({
      scope,
      transport,
      sleep: noSleep,
    });

    expect(await client.recordStart(startCall)).toBe(false);
    expect(calls).toHaveLength(3);
    // Nothing is claimed as started: the call will not run, so there is no
    // execution for a later completeness check to look for.
    expect(client.startedRequestIds.size).toBe(0);
  });

  test("stops immediately on a failure the backend calls permanent", async () => {
    // A scope that is gone, or a payload that will never fit. Retrying spends
    // a model's patience on a write that cannot succeed.
    const { transport, calls } = transportReturning({
      status: 409,
      body: { code: "iteration_not_found", retryable: false },
    });
    const client = createHarnessEvidenceClient({
      scope,
      transport,
      sleep: noSleep,
    });

    expect(await client.recordStart(startCall)).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("recordSettlement", () => {
  test("acknowledges and clears the request from the unsettled set", async () => {
    const { transport, calls } = transportReturning({ status: 200 });
    const client = createHarnessEvidenceClient({ scope, transport });

    await client.recordStart(startCall);
    expect([...client.unsettledRequestIds]).toEqual(["req_1"]);

    expect(
      await client.recordSettlement({
        requestId: "req_1",
        outcomeKind: "success",
        response: { content: [{ type: "text", text: "ok" }] },
        settledAtMs: 1_050,
      }),
    ).toBe(true);

    expect(client.unsettledRequestIds.size).toBe(0);
    expect(calls[1][1]).toMatchObject({
      iterationId: "iter_1",
      requestId: "req_1",
      outcomeKind: "success",
      settledAtMs: 1_050,
    });
  });

  test("leaves the request UNSETTLED when the budget runs out", async () => {
    // The visible loss. The call happened and its result went back to the
    // harness; what did not happen is the record of how it ended, and the
    // turn's completeness check reads exactly this.
    const { transport } = transportReturning(
      { status: 200 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    );
    const client = createHarnessEvidenceClient({
      scope,
      transport,
      sleep: noSleep,
    });

    await client.recordStart(startCall);
    expect(
      await client.recordSettlement({
        requestId: "req_1",
        outcomeKind: "success",
        response: {},
        settledAtMs: 1_050,
      }),
    ).toBe(false);

    expect([...client.startedRequestIds]).toEqual(["req_1"]);
    expect([...client.unsettledRequestIds]).toEqual(["req_1"]);
  });

  test("an unserializable response settles as a marker, not a throw", async () => {
    // A cycle would otherwise take the whole settlement down. The marker is
    // deliberately not a valid result envelope, so the merge reads the row as
    // unreadable and the turn as incomplete — which is the truth.
    const { transport, calls } = transportReturning({ status: 200 });
    const client = createHarnessEvidenceClient({ scope, transport });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(
      await client.recordSettlement({
        requestId: "req_1",
        outcomeKind: "success",
        response: cyclic,
        settledAtMs: 1_050,
      }),
    ).toBe(true);

    expect(JSON.parse(calls[0][1].responseJson)).toMatchObject({
      mcpjamEvidenceError: "unserializable",
    });
  });

  test("carries each outcome kind through verbatim", async () => {
    const { transport, calls } = transportReturning({ status: 200 });
    const client = createHarnessEvidenceClient({ scope, transport });

    for (const outcomeKind of [
      "success",
      "call_tool_error",
      "jsonrpc_error",
    ] as const) {
      await client.recordSettlement({
        requestId: `req_${outcomeKind}`,
        outcomeKind,
        response: {},
        settledAtMs: 1,
      });
    }

    expect(calls.map(([, body]) => body.outcomeKind)).toEqual([
      "success",
      "call_tool_error",
      "jsonrpc_error",
    ]);
  });
});

describe("cancellation", () => {
  test("stops retrying when the turn aborts", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const transport: HarnessEvidenceTransport = async (path) => {
      calls.push(path);
      controller.abort();
      return { status: 500, body: null };
    };
    const client = createHarnessEvidenceClient({
      scope,
      transport,
      signal: controller.signal,
      sleep: noSleep,
    });

    expect(await client.recordStart(startCall)).toBe(false);
    // One attempt, then the abort is observed rather than burning the budget
    // on a turn nobody is waiting for any more.
    expect(calls).toHaveLength(1);
  });
});

describe("a thrown transport", () => {
  test("is retried, not propagated", async () => {
    const transport = vi
      .fn<HarnessEvidenceTransport>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue({ status: 200, body: null });
    const client = createHarnessEvidenceClient({
      scope,
      transport,
      sleep: noSleep,
    });

    expect(await client.recordStart(startCall)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("infra 4xx without a verdict body", () => {
  test("a bare 429 is retryable — one throttled attempt is not a refused tool call", async () => {
    const { transport, calls } = transportReturning(
      { status: 429 },
      { status: 200 },
    );
    const client = createHarnessEvidenceClient({
      scope,
      transport,
      sleep: noSleep,
    });

    expect(await client.recordStart(startCall)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("a labeled-final 429 is still final — the backend's verdict wins", async () => {
    const { transport, calls } = transportReturning({
      status: 429,
      body: { retryable: false, code: "nope" },
    });
    const client = createHarnessEvidenceClient({
      scope,
      transport,
      sleep: noSleep,
    });

    expect(await client.recordStart(startCall)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("a 408 is retryable; an unlabeled 400 stays permanent", async () => {
    const retry = transportReturning({ status: 408 }, { status: 200 });
    expect(
      await createHarnessEvidenceClient({
        scope,
        transport: retry.transport,
        sleep: noSleep,
      }).recordStart(startCall),
    ).toBe(true);

    evidenceSinkBreaker.resetForTest();
    const permanent = transportReturning({ status: 400 });
    expect(
      await createHarnessEvidenceClient({
        scope,
        transport: permanent.transport,
        sleep: noSleep,
      }).recordStart(startCall),
    ).toBe(false);
    expect(permanent.calls).toHaveLength(1);
  });
});

describe("the per-iteration breaker", () => {
  test("opens after consecutive failed writes and then fails FAST", async () => {
    const dead = transportReturning({ status: 500 });
    // Three separate clients — the breaker's whole reason to exist is that
    // the client is rebuilt per proxied request and remembers nothing.
    for (let i = 0; i < 3; i += 1) {
      const client = createHarnessEvidenceClient({
        scope,
        transport: dead.transport,
        sleep: noSleep,
      });
      expect(await client.recordStart(startCall)).toBe(false);
    }
    const callsBeforeOpen = dead.calls.length;
    expect(callsBeforeOpen).toBeGreaterThan(0);

    // Breaker open: the next request is refused without touching the sink —
    // still fail-closed, just without making the model wait to hear it.
    const client = createHarnessEvidenceClient({
      scope,
      transport: dead.transport,
      sleep: noSleep,
    });
    expect(await client.recordStart(startCall)).toBe(false);
    expect(dead.calls.length).toBe(callsBeforeOpen);
  });

  test("a success closes it again", async () => {
    const flaky = transportReturning(
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 200 },
    );
    const failing = createHarnessEvidenceClient({
      scope,
      transport: flaky.transport,
      sleep: noSleep,
    });
    expect(await failing.recordStart(startCall)).toBe(false);
    // One failed WRITE (three attempts) = one breaker strike; two more strikes.
    evidenceSinkBreaker.recordFailure(scope.iterationId);
    evidenceSinkBreaker.recordFailure(scope.iterationId);
    expect(evidenceSinkBreaker.isOpen(scope.iterationId)).toBe(true);

    evidenceSinkBreaker.recordSuccess(scope.iterationId);
    expect(evidenceSinkBreaker.isOpen(scope.iterationId)).toBe(false);
  });

  test("a different iteration's breaker does not trip this one", async () => {
    for (let i = 0; i < 3; i += 1) {
      evidenceSinkBreaker.recordFailure("iter_other");
    }
    expect(evidenceSinkBreaker.isOpen("iter_other")).toBe(true);
    expect(evidenceSinkBreaker.isOpen(scope.iterationId)).toBe(false);
  });
});
