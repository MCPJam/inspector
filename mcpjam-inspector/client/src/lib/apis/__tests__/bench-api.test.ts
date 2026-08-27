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

beforeEach(() => {
  authFetchMock.mockReset();
  fetchMock.mockReset();
});

describe("a relay whose backend has not enabled benchmark runs", () => {
  it.each([
    ["preflightBench", () => preflightBench(TARGET)],
    ["quoteBench", () => quoteBench(TARGET)],
    ["startBenchRun", () => startBenchRun({ ...TARGET, receiptId: "rcpt_1" })],
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

    await expect(
      startBenchRun({ ...TARGET, receiptId: "rcpt_1" }),
    ).rejects.toThrow("Not enough credits");
  });
});
