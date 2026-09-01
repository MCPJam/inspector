/**
 * Reading back a turn's evidence — the other end of what the proxy wrote.
 *
 * Two properties make this more than a fetch loop, and both exist because the
 * completeness check downstream is only as trustworthy as this read:
 *
 * ONE SNAPSHOT PER TURN. The whole row set is read once, and everything —
 * completeness, the merge, the trace projection, grading — consumes THAT set.
 * Re-reading between those steps could see a laggard settle land in the middle
 * and have two consumers disagree about whether the same turn was complete.
 *
 * PAGINATION IS PART OF THE ANSWER. A read that stopped early looks exactly
 * like a turn with fewer calls, so `exhausted` is reported rather than assumed:
 * an unfinished read makes the turn incomplete, which is the honest answer to
 * "is anything missing?" when the reader cannot say.
 */
import { logger } from "../logger.js";
import type { EvidenceRow } from "../../services/evals/harness-evidence-merge.js";

/** Pages, not rows: a bound on requests for a turn with pathological fan-out. */
const MAX_PAGES = 50;
const PAGE_SIZE = 200;

export type EvidenceReadResult = {
  rows: EvidenceRow[];
  /** Whether pagination reached the end. False ⇒ the turn is incomplete. */
  exhausted: boolean;
};

export type EvidenceReadTransport = (body: {
  iterationId: string;
  turnId: string;
  cursor: string | null;
  pageSize: number;
}) => Promise<{ status: number; body: Record<string, unknown> | null }>;

/** The production transport: the backend's service-token read route. */
export function createConvexEvidenceReadTransport(): EvidenceReadTransport {
  return async (body) => {
    const base = process.env.CONVEX_HTTP_URL?.trim();
    const token = process.env.INSPECTOR_SERVICE_TOKEN?.trim();
    if (!base || !token) return { status: 500, body: null };
    const response = await fetch(
      new URL("/eval-harness-tool-calls/read", base).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-inspector-service-token": token,
        },
        body: JSON.stringify(body),
      },
    );
    let parsed: Record<string, unknown> | null = null;
    try {
      const json = await response.json();
      parsed =
        json && typeof json === "object" && !Array.isArray(json)
          ? (json as Record<string, unknown>)
          : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };
}

function readRows(payload: Record<string, unknown> | null): EvidenceRow[] {
  const rows = payload?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    if (
      typeof row.requestId !== "string" ||
      typeof row.turnId !== "string" ||
      typeof row.serverId !== "string" ||
      typeof row.toolName !== "string" ||
      (row.status !== "started" && row.status !== "settled") ||
      typeof row.startedAtMs !== "number"
    ) {
      // A row this reader cannot understand is DROPPED, and dropping it is
      // safe only because the caller treats a short read as incomplete: the
      // turn degrades to narration grading rather than being graded against a
      // record with a hole in it.
      return [];
    }
    return [
      {
        requestId: row.requestId,
        turnId: row.turnId,
        serverId: row.serverId,
        toolName: row.toolName,
        argumentsJson:
          typeof row.argumentsJson === "string" ? row.argumentsJson : null,
        status: row.status,
        outcomeKind:
          row.outcomeKind === "success" ||
          row.outcomeKind === "call_tool_error" ||
          row.outcomeKind === "jsonrpc_error"
            ? row.outcomeKind
            : null,
        responseJson:
          typeof row.responseJson === "string" ? row.responseJson : null,
        startedAtMs: row.startedAtMs,
        settledAtMs:
          typeof row.settledAtMs === "number" ? row.settledAtMs : null,
        payloadsReadable: row.payloadsReadable !== false,
      },
    ];
  });
}

/**
 * Read every evidence row for one turn, once.
 *
 * Never throws: a read failure is reported as a short read, which the
 * completeness check turns into "this turn grades from narration". Throwing
 * would take down the turn's persistence over a record that is, by
 * construction, supplementary to it.
 */
export async function readTurnEvidence(args: {
  iterationId: string;
  turnId: string;
  transport: EvidenceReadTransport;
}): Promise<EvidenceReadResult> {
  const rows: EvidenceRow[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: Awaited<ReturnType<EvidenceReadTransport>>;
    try {
      response = await args.transport({
        iterationId: args.iterationId,
        turnId: args.turnId,
        cursor,
        pageSize: PAGE_SIZE,
      });
    } catch (error) {
      logger.warn("[harness-evidence] read failed", {
        iterationId: args.iterationId,
        turnId: args.turnId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { rows, exhausted: false };
    }

    if (response.status < 200 || response.status >= 300) {
      logger.warn("[harness-evidence] read returned an error status", {
        iterationId: args.iterationId,
        turnId: args.turnId,
        status: response.status,
      });
      return { rows, exhausted: false };
    }

    rows.push(...readRows(response.body));

    if (response.body?.isDone === true) return { rows, exhausted: true };
    const nextCursor = response.body?.cursor;
    if (typeof nextCursor !== "string" || nextCursor === cursor) {
      // No usable cursor and not done: the reader cannot advance, so it says
      // so rather than reporting what it happens to hold as the whole set.
      return { rows, exhausted: false };
    }
    cursor = nextCursor;
  }

  // Hit the page bound. Whatever the cause, this read did not prove it saw
  // everything, and that is what gets reported.
  logger.warn("[harness-evidence] read hit the page bound", {
    iterationId: args.iterationId,
    turnId: args.turnId,
    rows: rows.length,
  });
  return { rows, exhausted: false };
}
