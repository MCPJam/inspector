import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bench client's job is almost entirely error translation: the relay
 * answers a deployment that has not enabled benchmark runs differently from
 * one that cannot find a run, and the score site renders those two as
 * completely different pages. The properties worth pinning:
 *
 *  - a 503 FEATURE_NOT_SUPPORTED becomes its own type, so callers hide the
 *    entry point rather than offering a retry that can never work;
 *  - a 404 on a result link becomes its own type, so a bad link says so;
 *  - an error body that is not JSON still produces the caller's message rather
 *    than a parse failure;
 *  - a result read that comes back without its envelope is a failure, not an
 *    `undefined` handed to the renderer.
 */

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;

import {
  BenchNotEnabledError,
  BenchResultNotFoundError,
  cancelBenchRun,
  fetchBenchResult,
  fetchBenchRun,
  preflightBench,
  quoteBench,
  startBenchRun,
} from "../bench-api";

/** Enough of a Response for these paths; the real one needs a jsdom polyfill. */
function reply(
  status: number,
  body: unknown,
  options: { json?: () => Promise<unknown> } = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: options.json ?? (() => Promise.resolve(body)),
  };
}

/** An HTML error page, a gateway's plain text — anything but our envelope. */
function nonJsonReply(status: number) {
  return reply(status, null, {
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
  });
}

const TARGET = { projectId: "proj_1", serverId: "srv_1" };

/**
 * The real argument shapes, not convenient subsets.
 *
 * A quote is priced against the stable target and one exact exam, and a start
 * is the acceptance of a quote — so `benchmarkTargetId`/`profileId` and
 * `quoteId` are required, and the backend refuses the call without them. The
 * table below used to pass `TARGET` alone to both, which type-checked nowhere
 * (client tests are excluded from `typecheck:client`) and passed anyway
 * because the mocked failure lands before anything reads the payload. That is
 * exactly the blind spot the happy-path block below closes: an error-only
 * suite stays green straight through a contract change that breaks every one
 * of these calls.
 */
const QUOTE_INPUT = {
  ...TARGET,
  benchmarkTargetId: "btgt_1",
  profileId: "connector-bench/crm/standard",
  profileVersion: "1.0.0",
};
const START_INPUT = {
  ...TARGET,
  quoteId: "quote_1",
  receiptId: "rcpt_1",
};

beforeEach(() => {
  authFetchMock.mockReset();
  fetchMock.mockReset();
});

describe("a relay whose backend has not enabled benchmark runs", () => {
  it.each([
    ["preflightBench", () => preflightBench(TARGET)],
    ["quoteBench", () => quoteBench(QUOTE_INPUT)],
    ["startBenchRun", () => startBenchRun(START_INPUT)],
    ["fetchBenchRun", () => fetchBenchRun("run_1")],
    ["cancelBenchRun", () => cancelBenchRun("run_1")],
  ])(
    "maps %s's 503 FEATURE_NOT_SUPPORTED to BenchNotEnabledError",
    async (_label, call) => {
      authFetchMock.mockResolvedValue(
        reply(503, {
          code: "FEATURE_NOT_SUPPORTED",
          message: "Benchmark runs are not enabled for this deployment yet.",
        }),
      );

      await expect(call()).rejects.toBeInstanceOf(BenchNotEnabledError);
      await expect(call()).rejects.toThrow(/not enabled/);
    },
  );

  it("reaches the public result read too, which takes no session", async () => {
    fetchMock.mockResolvedValue(
      reply(503, {
        code: "FEATURE_NOT_SUPPORTED",
        message: "Benchmark runs are not enabled for this deployment yet.",
      }),
    );

    await expect(fetchBenchResult("sec_abc")).rejects.toBeInstanceOf(
      BenchNotEnabledError,
    );
    // The whole reason this one call uses a plain fetch: a result-page visitor
    // may have no session, and authFetch would mint a guest one to read a
    // public document.
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("leaves a 503 that is NOT the feature code as an ordinary error", async () => {
    // "Not configured" and "not enabled" share a status and mean different
    // things; only the second is a deployment state the UI should hide for.
    authFetchMock.mockResolvedValue(
      reply(503, { message: "Benchmark runs are not configured" }),
    );

    const failure = await preflightBench(TARGET).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(BenchNotEnabledError);
    expect(failure.message).toBe("Benchmark runs are not configured");
  });
});

describe("fetchBenchResult", () => {
  it("maps a 404 to BenchResultNotFoundError with the relay's wording", async () => {
    fetchMock.mockResolvedValue(
      reply(404, {
        message: "That result link is not valid, or the run no longer exists.",
      }),
    );

    await expect(fetchBenchResult("nope")).rejects.toThrow(
      BenchResultNotFoundError,
    );
    await expect(fetchBenchResult("nope")).rejects.toThrow(/not valid/);
  });

  it("escapes the secret it is handed rather than pasting it into the path", async () => {
    fetchMock.mockResolvedValue(reply(200, { result: { runId: "run_1" } }));

    await fetchBenchResult("a/b?c");

    expect(fetchMock).toHaveBeenCalledWith("/api/web/bench/results/a%2Fb%3Fc");
  });

  it("rejects a 200 that arrives without its `result` envelope", async () => {
    // A backend that answered but relayed nothing must not become an
    // `undefined` the result page renders as a blank score.
    fetchMock.mockResolvedValue(reply(200, { success: true }));

    await expect(fetchBenchResult("sec_abc")).rejects.toThrow(
      "Could not load this benchmark result.",
    );
  });

  it("returns the artifact when the envelope is there", async () => {
    fetchMock.mockResolvedValue(
      reply(200, { success: true, result: { runId: "run_1", score: 71 } }),
    );

    await expect(fetchBenchResult("sec_abc")).resolves.toEqual({
      runId: "run_1",
      score: 71,
    });
  });

  it("does not treat a not-ready backend response as a report", async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        success: true,
        result: { benchmarkRunId: "run_1", ready: false, status: "running" },
      }),
    );

    await expect(fetchBenchResult("sec_abc")).rejects.toThrow(
      /still being scored/,
    );
  });

  it("hydrates the immutable rich report when the backend provides its blob URL", async () => {
    fetchMock
      .mockResolvedValueOnce(
        reply(200, {
          success: true,
          result: {
            benchmarkRunId: "run_1",
            ready: true,
            completedAt: 42,
            profile: { id: "bench", version: "1", definitionHash: "h" },
            scorecard: {
              status: "scored",
              verification: "mcpjam_verified",
              scores: { core: 80, category: 70, composite: 75 },
              reportUrl: "https://storage.test/report.json",
              publicEligible: true,
              publication: { status: "active" },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        reply(200, {
          status: "scored",
          scores: { core: 81, category: 71, composite: 76 },
          sections: {
            coreProtocol: {
              section: "coreProtocol",
              coverage: "eligible",
              score: 81,
            },
            protocolExtensions: {
              section: "protocolExtensions",
              coverage: "not_applicable",
              score: null,
            },
            workflowReliability: {
              section: "workflowReliability",
              coverage: "eligible",
              score: 71,
            },
            overall: 76,
          },
          slices: [],
          provisionalReasons: [],
          publication: { publicEligible: true, reasons: [] },
          provenance: { evidenceDigest: "digest" },
        }),
      );

    await expect(fetchBenchResult("sec_abc")).resolves.toMatchObject({
      runId: "run_1",
      finishedAt: 42,
      scorecard: {
        sections: expect.objectContaining({ overall: 76 }),
        evidenceDigest: "digest",
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://storage.test/report.json",
    );
  });
});

describe("an error body that is not JSON at all", () => {
  it("falls back to the caller's message on the authed calls", async () => {
    authFetchMock.mockResolvedValue(nonJsonReply(502));

    await expect(preflightBench(TARGET)).rejects.toThrow(
      "Could not prepare this benchmark.",
    );
  });

  it("falls back on a result 404, where the type still has to be right", async () => {
    fetchMock.mockResolvedValue(nonJsonReply(404));

    const failure = await fetchBenchResult("nope").catch((error) => error);
    expect(failure).toBeInstanceOf(BenchResultNotFoundError);
    expect(failure.message).toBe(
      "That result link is not valid, or the run no longer exists.",
    );
  });

  it("falls back on a non-JSON result failure that is not a 404", async () => {
    fetchMock.mockResolvedValue(nonJsonReply(500));

    await expect(fetchBenchResult("sec_abc")).rejects.toThrow(
      "Could not load this benchmark result.",
    );
  });
});

describe("the authed calls", () => {
  it("post the target through authFetch and return the parsed body", async () => {
    authFetchMock.mockResolvedValue(
      reply(200, { receiptId: "rcpt_1", toolCount: 3 }),
    );

    await expect(preflightBench(TARGET)).resolves.toMatchObject({
      receiptId: "rcpt_1",
      toolCount: 3,
    });
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/bench/preflight",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(TARGET),
      }),
    );
  });

  it("prefers the body's `message` over its `error`", async () => {
    authFetchMock.mockResolvedValue(
      reply(402, { message: "Not enough credits", error: "BILLING" }),
    );

    await expect(startBenchRun(START_INPUT)).rejects.toThrow(
      "Not enough credits",
    );
  });
});

/**
 * What each call puts on the wire, and what it hands back.
 *
 * Everything above this point asserts error TRANSLATION, which is shared by
 * all five calls and therefore says nothing about any one of them. A wrong
 * method, a wrong path, a dropped field, or a response read out of the wrong
 * envelope all survive a suite that only ever mocks a failure — and every one
 * of those has actually happened on this surface: `/runs` was quoted without
 * `quoteId`, `/quotes` without `benchmarkTargetId`, and the poll response was
 * read with its wrapper still on.
 *
 * `toEqual` on the body rather than `toMatchObject`, deliberately: a field
 * that should not be sent is as much a contract break as one that should.
 */
describe("what each call sends, and what it gives back", () => {
  const post = (payload: Record<string, unknown>) =>
    expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  it("prices a quote against the target and the exam, not the saved server", async () => {
    authFetchMock.mockResolvedValue(
      reply(200, {
        quoteId: "quote_1",
        totalCredits: 42,
        writesToTarget: true,
      }),
    );

    await expect(quoteBench(QUOTE_INPUT)).resolves.toEqual({
      quoteId: "quote_1",
      totalCredits: 42,
      writesToTarget: true,
    });
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/bench/quotes",
      post(QUOTE_INPUT),
    );
  });

  it("starts a run by accepting a quote, carrying consent and an idempotency key", async () => {
    // Consent and the idempotency key are both optional in the type and both
    // load-bearing when present: the backend re-checks the agreement against
    // the definition's hashes, and the key is what lets a lost start be
    // retried without commissioning a second paid run.
    const input = {
      ...START_INPUT,
      consent: { writeCases: true },
      idempotencyKey: "idem_1",
    };
    authFetchMock.mockResolvedValue(
      reply(200, {
        benchmarkRunId: "brun_1",
        status: "queued",
        resultSecret: "sec_abc",
      }),
    );

    await expect(startBenchRun(input)).resolves.toEqual({
      benchmarkRunId: "brun_1",
      status: "queued",
      // Returned by the start and only by the start — the backend keeps a
      // digest, so if this were dropped here the plaintext would be gone.
      resultSecret: "sec_abc",
    });
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/bench/runs",
      post(input),
    );
  });

  it("polls a run with a bare GET, and no body at all", async () => {
    authFetchMock.mockResolvedValue(
      reply(200, { benchmarkRunId: "brun_1", status: "running" }),
    );

    await expect(fetchBenchRun("brun_1")).resolves.toEqual({
      benchmarkRunId: "brun_1",
      status: "running",
    });
    // One argument, exactly: passing an init here at all would be the start of
    // sending a method or a body on a read.
    expect(authFetchMock).toHaveBeenCalledWith("/api/web/bench/runs/brun_1");
    expect(authFetchMock.mock.calls[0]).toHaveLength(1);
  });

  it("cancels with a POST to the run's own path, and sends no body", async () => {
    authFetchMock.mockResolvedValue(
      reply(200, { benchmarkRunId: "brun_1", status: "cancelled" }),
    );

    await expect(cancelBenchRun("brun_1")).resolves.toEqual({
      benchmarkRunId: "brun_1",
      status: "cancelled",
    });
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/bench/runs/brun_1/cancel",
      { method: "POST" },
    );
  });

  it("hands back the relay's body verbatim, and does not unwrap on its own", async () => {
    // `/runs/get` is the one backend route that nests its entity, and
    // `relayedRun()` is where that gets flattened — one place, so a run has
    // one shape however it was obtained. This pins that the client does not
    // grow a second unwrapper: a nested body arriving here means the relay
    // regressed, and absorbing it quietly would hide that behind a poll that
    // simply never reports a terminal status.
    authFetchMock.mockResolvedValue(
      reply(200, { run: { benchmarkRunId: "brun_1", status: "completed" } }),
    );

    await expect(fetchBenchRun("brun_1")).resolves.toEqual({
      run: { benchmarkRunId: "brun_1", status: "completed" },
    });
  });
});

/**
 * Ids and secrets that are not ordinary.
 *
 * This module is a transport: it has no validation layer, and deliberately so
 * — the relay validates with zod, and a second copy of those rules here would
 * be a second place for them to drift. So the property to pin is not "null is
 * rejected" (nothing here would reject it) but that whatever it is handed goes
 * into the path ESCAPED rather than concatenated, and that an id which is
 * missing entirely produces a path that cannot be mistaken for another route.
 */
describe("ids and secrets that are not ordinary", () => {
  it("escapes a run id rather than letting it reshape the path", async () => {
    authFetchMock.mockResolvedValue(reply(200, {}));

    await fetchBenchRun("a/b?c");
    await cancelBenchRun("a/b?c");

    expect(authFetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/web/bench/runs/a%2Fb%3Fc",
    );
    // Without the escape this reads `/runs/a/b?c/cancel` — a different route
    // with a query string, on a call that CANCELS things.
    expect(authFetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/web/bench/runs/a%2Fb%3Fc/cancel",
      { method: "POST" },
    );
  });

  it("does not collapse a missing run id into the collection path", async () => {
    authFetchMock.mockResolvedValue(reply(404, { message: "No such run" }));

    await expect(fetchBenchRun("")).rejects.toThrow("No such run");
    // The trailing slash is the point: `/runs` is the START route, and a poll
    // that silently addressed it would be a paid run rather than a read.
    expect(authFetchMock).toHaveBeenCalledWith("/api/web/bench/runs/");
  });

  it("keeps an empty result secret out of the collection path too", async () => {
    fetchMock.mockResolvedValue(reply(404, { message: "Not a valid link" }));

    await expect(fetchBenchResult("")).rejects.toBeInstanceOf(
      BenchResultNotFoundError,
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/web/bench/results/");
  });

  it("reads a null body on an error as no message, not as a crash", async () => {
    // `response.json()` resolving to `null` is a different path from it
    // rejecting: `body?.message` is fine, but a non-optional read would throw
    // inside the error handler and replace the caller's message with a
    // TypeError.
    authFetchMock.mockResolvedValue(reply(500, null));

    await expect(quoteBench(QUOTE_INPUT)).rejects.toThrow(
      "Could not price this benchmark.",
    );
  });
});
