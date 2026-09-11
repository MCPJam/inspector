/**
 * Reading a turn's evidence back.
 *
 * Every test here is a variation on one question: when the reader cannot prove
 * it saw everything, does it SAY so? A short read that reports itself as
 * complete is indistinguishable from a turn with fewer tool calls, and that is
 * the one confusion the whole protocol is built to avoid.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  readTurnEvidence,
  type EvidenceReadTransport,
} from "../harness-evidence-reader";

const scope = { iterationId: "iter_1", turnId: "turn_1" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function page(
  rows: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
) {
  return {
    status: 200,
    body: { ok: true, rows, isDone: true, cursor: null, ...over },
  };
}

const settledRow = {
  requestId: "req-1",
  turnId: "turn_1",
  serverId: "server-1",
  toolName: "search",
  argumentsJson: '{"q":"x"}',
  status: "settled",
  outcomeKind: "success",
  responseJson: '{"content":[]}',
  startedAtMs: 1_000,
  settledAtMs: 1_050,
  payloadsReadable: true,
};

describe("a complete read", () => {
  test("returns the rows and reports exhaustion", async () => {
    const transport: EvidenceReadTransport = async () => page([settledRow]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.exhausted).toBe(true);
    expect(result.rows).toEqual([
      expect.objectContaining({ requestId: "req-1", status: "settled" }),
    ]);
  });

  test("follows the cursor across pages, in order", async () => {
    const transport = vi
      .fn<EvidenceReadTransport>()
      .mockResolvedValueOnce(
        page([{ ...settledRow, requestId: "a" }], {
          isDone: false,
          cursor: "c1",
        }),
      )
      .mockResolvedValueOnce(
        page([{ ...settledRow, requestId: "b" }], {
          isDone: false,
          cursor: "c2",
        }),
      )
      .mockResolvedValueOnce(page([{ ...settledRow, requestId: "c" }]));

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.exhausted).toBe(true);
    expect(result.rows.map((r) => r.requestId)).toEqual(["a", "b", "c"]);
    expect(transport.mock.calls[1][0].cursor).toBe("c1");
    expect(transport.mock.calls[2][0].cursor).toBe("c2");
  });

  test("scopes the read to one turn", async () => {
    // A turn retry mints a fresh turn id, and the stale attempt's rows are
    // real calls that really executed — they just belong to a different turn.
    const transport = vi
      .fn<EvidenceReadTransport>()
      .mockResolvedValue(page([]));

    await readTurnEvidence({ ...scope, transport });

    expect(transport.mock.calls[0][0]).toMatchObject({
      iterationId: "iter_1",
      turnId: "turn_1",
    });
  });
});

describe("a read that cannot prove it saw everything", () => {
  test("an error status is a SHORT read, not an empty turn", async () => {
    const transport: EvidenceReadTransport = async () => ({
      status: 500,
      body: null,
    });

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result).toEqual({ rows: [], exhausted: false, unparseableRows: 0 });
  });

  test("a thrown transport is reported, never propagated", async () => {
    // Throwing would take down the turn's persistence over a record that is,
    // by construction, supplementary to it.
    const transport: EvidenceReadTransport = async () => {
      throw new Error("ECONNRESET");
    };

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.exhausted).toBe(false);
  });

  test("keeps the rows it did read when a later page fails", async () => {
    // Partial rows are still useful for a human reading the trace; what must
    // not survive is the CLAIM that they are the whole set.
    const transport = vi
      .fn<EvidenceReadTransport>()
      .mockResolvedValueOnce(
        page([settledRow], { isDone: false, cursor: "c1" }),
      )
      .mockResolvedValueOnce({ status: 503, body: null });

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.rows).toHaveLength(1);
    expect(result.exhausted).toBe(false);
  });

  test("a missing or repeating cursor stops the loop rather than spinning", async () => {
    const noCursor: EvidenceReadTransport = async () =>
      page([settledRow], { isDone: false, cursor: null });
    expect(
      await readTurnEvidence({ ...scope, transport: noCursor }),
    ).toMatchObject({ exhausted: false });

    const stuck = vi
      .fn<EvidenceReadTransport>()
      .mockResolvedValue(page([settledRow], { isDone: false, cursor: "same" }));
    const result = await readTurnEvidence({ ...scope, transport: stuck });
    // First page sets the cursor, second sees it unchanged and stops.
    expect(stuck).toHaveBeenCalledTimes(2);
    expect(result.exhausted).toBe(false);
  });

  test("bounds the number of pages", async () => {
    let n = 0;
    const endless: EvidenceReadTransport = async () => {
      n += 1;
      return page([settledRow], { isDone: false, cursor: `c${n}` });
    };

    const result = await readTurnEvidence({ ...scope, transport: endless });

    expect(result.exhausted).toBe(false);
    expect(n).toBeLessThanOrEqual(50);
  });
});

describe("row parsing", () => {
  test("carries the fields the completeness check reads", async () => {
    const transport: EvidenceReadTransport = async () =>
      page([
        {
          ...settledRow,
          requestId: "unsettled",
          status: "started",
          outcomeKind: null,
          responseJson: null,
          settledAtMs: null,
        },
        { ...settledRow, requestId: "unreadable", payloadsReadable: false },
      ]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.rows[0]).toMatchObject({
      status: "started",
      outcomeKind: null,
      settledAtMs: null,
    });
    expect(result.rows[1].payloadsReadable).toBe(false);
  });

  test("treats an ABSENT readability flag as readable", async () => {
    // Older rows predate the flag. Reading absence as unreadable would mark
    // every one of their turns incomplete for no reason.
    const { payloadsReadable: _omitted, ...withoutFlag } = settledRow;
    const transport: EvidenceReadTransport = async () => page([withoutFlag]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.rows[0].payloadsReadable).toBe(true);
  });

  test("drops a row it cannot understand — and COUNTS it, so the merge can refuse completeness", async () => {
    // The dangerous version of this behaviour was drop-and-stay-silent: with
    // `exhausted: true` and no count, a version-skewed row (the backend
    // deploys first) simply vanished, and the call it recorded was graded a
    // hallucination. The count is what turns the hole into an incomplete
    // turn instead of a false accusation.
    const transport: EvidenceReadTransport = async () =>
      page([{ requestId: "no-other-fields" }, settledRow]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.rows.map((r) => r.requestId)).toEqual(["req-1"]);
    expect(result.exhausted).toBe(true);
    expect(result.unparseableRows).toBe(1);
  });

  test("asks for a page the backend will actually serve", async () => {
    // The backend caps a page at 25 because a row can carry two inline
    // payloads. Asking for more just gets silently clamped.
    const transport = vi
      .fn<EvidenceReadTransport>()
      .mockResolvedValue(page([]));

    await readTurnEvidence({ ...scope, transport });

    expect(transport.mock.calls[0][0].pageSize).toBeLessThanOrEqual(25);
  });
});

describe("payloads the backend spilled to storage", () => {
  // The reader only fetches from the deployment it is configured against, so
  // every URL here has to look like one the backend would actually hand back.
  const STORE = "https://convex.example.test";
  const spilledRow = {
    ...settledRow,
    requestId: "spilled",
    argumentsJson: null,
    argumentsUrl: `${STORE}/args`,
    responseJson: null,
    responseUrl: `${STORE}/response`,
  };

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", STORE);
  });

  test("fetches a spilled payload and hands the merge an inline one", async () => {
    // The merge never learns a payload was spilled: it reads `argumentsJson`
    // either way, which is what keeps digest matching identical on both sides
    // of the size threshold.
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/args")
        ? new Response('{"q":"x"}')
        : new Response('{"content":[]}'),
    );
    vi.stubGlobal("fetch", fetchMock);
    const transport: EvidenceReadTransport = async () => page([spilledRow]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.exhausted).toBe(true);
    expect(result.rows[0]).toMatchObject({
      argumentsJson: '{"q":"x"}',
      responseJson: '{"content":[]}',
      payloadsReadable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a payload that will not come back is UNREADABLE, never empty", async () => {
    // Reading a failed fetch as an empty payload would be the silent version
    // of exactly the loss this protocol exists to make visible.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    const transport: EvidenceReadTransport = async () => page([spilledRow]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.rows[0].payloadsReadable).toBe(false);
    expect(result.rows[0].argumentsJson).toBeNull();
  });

  test("a thrown fetch degrades the row rather than the read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      }),
    );
    const transport: EvidenceReadTransport = async () =>
      page([settledRow, spilledRow]);

    const result = await readTurnEvidence({ ...scope, transport });

    // The read itself still completed — one bad blob must not turn a whole
    // page into a short read, because the OTHER rows are still trustworthy.
    expect(result.exhausted).toBe(true);
    expect(result.rows[0].payloadsReadable).toBe(true);
    expect(result.rows[1].payloadsReadable).toBe(false);
  });

  test("does not refetch a payload that already travelled inline", async () => {
    // A row can carry a URL alongside an inline copy; the inline one wins,
    // because it is already the same bytes without a round trip.
    const fetchMock = vi.fn(async () => new Response("from-storage"));
    vi.stubGlobal("fetch", fetchMock);
    const transport: EvidenceReadTransport = async () =>
      page([{ ...settledRow, argumentsUrl: `${STORE}/args` }]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.rows[0].argumentsJson).toBe('{"q":"x"}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a started row's absent response is not mistaken for a spill", async () => {
    // An in-flight call has no response and no URL. Nothing to fetch, and the
    // row stays readable — it is INCOMPLETE, which the caller judges, not
    // unreadable, which is a different failure.
    const fetchMock = vi.fn(async () => new Response("x"));
    vi.stubGlobal("fetch", fetchMock);
    const transport: EvidenceReadTransport = async () =>
      page([
        {
          ...settledRow,
          status: "started",
          outcomeKind: null,
          responseJson: null,
          settledAtMs: null,
        },
      ]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.rows[0].payloadsReadable).toBe(true);
  });

  test("a SETTLED row with no payload and no URL is unreadable, not empty", async () => {
    // Inline JSON and spill URL are written by one backend in one mutation,
    // so neither being present means version skew or a truncated write. Read
    // as an empty response it would grade as a call that succeeded and
    // returned nothing — a false record rather than a missing one.
    const fetchMock = vi.fn(async () => new Response("x"));
    vi.stubGlobal("fetch", fetchMock);
    const transport: EvidenceReadTransport = async () =>
      page([{ ...settledRow, responseJson: null }]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.rows[0].payloadsReadable).toBe(false);
  });

  test("refuses a URL that is not the configured deployment", async () => {
    // The URL arrives over an authenticated channel, so this is defence in
    // depth — but it is still a server-side fetch of a URL that came over the
    // wire, and the reader should not be the thing that follows it anywhere.
    const fetchMock = vi.fn(async () => new Response("secret"));
    vi.stubGlobal("fetch", fetchMock);
    const transport: EvidenceReadTransport = async () =>
      page([
        {
          ...spilledRow,
          argumentsUrl: "http://169.254.169.254/latest/meta-data/",
          responseUrl: "https://convex.example.test.evil.test/response",
        },
      ]);

    const result = await readTurnEvidence({ ...scope, transport });

    // Neither the link-local address nor the origin that merely PREFIXES the
    // trusted one is fetched, and the row degrades instead.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.rows[0].payloadsReadable).toBe(false);
  });

  test("refuses to follow a redirect away from the checked origin", async () => {
    const fetchMock = vi.fn(async () => new Response('{"q":"x"}'));
    vi.stubGlobal("fetch", fetchMock);
    const transport: EvidenceReadTransport = async () => page([spilledRow]);

    await readTurnEvidence({ ...scope, transport });

    // The origin was checked on the URL in hand; a 302 would move the fetch
    // somewhere that check never saw.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  test("a payload whose DECLARED size is over the cap is refused", async () => {
    // A fresh Response per call, deliberately: one shared Response fails the
    // second read on an already-consumed body, which would make this test
    // pass with no cap in place at all.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x".repeat(1024), {
            headers: { "content-length": String(64 * 1024 * 1024) },
          }),
      ),
    );
    const transport: EvidenceReadTransport = async () => page([spilledRow]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.rows[0].payloadsReadable).toBe(false);
    expect(result.rows[0].argumentsJson).toBeNull();
  });

  test("a payload that runs over the cap mid-stream is cancelled, not buffered", async () => {
    // The case a content-length check cannot catch: a chunked body that only
    // reveals its size as it arrives. `response.text()` would decode all of it
    // before anything could object, so the stream has to be abandoned in
    // flight — and abandoning it is the assertion.
    const chunk = new Uint8Array(2 * 1024 * 1024);
    let cancelled = false;
    const makeResponse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeResponse()),
    );
    const transport: EvidenceReadTransport = async () => page([spilledRow]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(cancelled).toBe(true);
    expect(result.rows[0].payloadsReadable).toBe(false);
  });

  test("stops resolving once the whole pass runs out of time", async () => {
    // Resolution is sequential, so the per-fetch timeout multiplies across a
    // high-fan-out turn: only a shared deadline keeps the pass inside the
    // iteration watchdog it is blocking.
    const realNow = Date.now;
    let clock = realNow.call(Date);
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const fetchMock = vi.fn(async () => {
      clock += 30_000; // each fetch burns half the budget
      return new Response('{"q":"x"}');
    });
    vi.stubGlobal("fetch", fetchMock);
    const rows = Array.from({ length: 8 }, (_, i) => ({
      ...spilledRow,
      requestId: `spilled-${i}`,
    }));
    const transport: EvidenceReadTransport = async () => page(rows);

    const result = await readTurnEvidence({ ...scope, transport });

    // It gave up well short of 16 fetches, and every row it could not resolve
    // is reported unreadable rather than silently empty.
    expect(fetchMock.mock.calls.length).toBeLessThan(8);
    expect(result.rows.some((r) => r.payloadsReadable === false)).toBe(true);
  });
});
