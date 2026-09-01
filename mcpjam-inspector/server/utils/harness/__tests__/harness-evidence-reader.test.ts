/**
 * Reading a turn's evidence back.
 *
 * Every test here is a variation on one question: when the reader cannot prove
 * it saw everything, does it SAY so? A short read that reports itself as
 * complete is indistinguishable from a turn with fewer tool calls, and that is
 * the one confusion the whole protocol is built to avoid.
 */
import { describe, expect, test, vi } from "vitest";
import {
  readTurnEvidence,
  type EvidenceReadTransport,
} from "../harness-evidence-reader";

const scope = { iterationId: "iter_1", turnId: "turn_1" };

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

    expect(result).toEqual({ rows: [], exhausted: false });
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

  test("drops a row it cannot understand, and the caller still sees exhaustion", async () => {
    // Dropping is only safe because a malformed row means the page's shape is
    // not what this reader knows; the row set is still whole as far as the
    // backend is concerned, and the merge treats what it gets on its merits.
    const transport: EvidenceReadTransport = async () =>
      page([{ requestId: "no-other-fields" }, settledRow]);

    const result = await readTurnEvidence({ ...scope, transport });

    expect(result.rows.map((r) => r.requestId)).toEqual(["req-1"]);
    expect(result.exhausted).toBe(true);
  });
});
