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
/**
 * Matches the backend's page ceiling. A page is sized against the RESPONSE
 * limit — a row can carry two inline payloads — so asking for more than the
 * backend will give just wastes a round trip.
 */
const PAGE_SIZE = 25;
/** A spilled payload's fetch, bounded so one huge blob cannot hang a turn. */
const PAYLOAD_FETCH_TIMEOUT_MS = 15_000;
/**
 * The whole resolution pass, across every row and both payloads.
 *
 * The per-fetch timeout does not bound this: resolution is sequential (see
 * {@link resolveSpilledPayloads}), so a turn with pathological fan-out and an
 * unavailable store multiplies it — 50 pages x 25 rows x 2 payloads x 15 s is
 * on the order of ten hours, against an iteration watchdog measured in
 * minutes. This is the bound that actually holds, and hitting it degrades the
 * turn to narration grading rather than hanging the iteration that is waiting
 * on it.
 */
const PAYLOAD_RESOLUTION_BUDGET_MS = 60_000;
/**
 * Largest spilled payload accepted into memory.
 *
 * `response.text()` buffers whatever arrives, and the timeout bounds duration,
 * not size — a large or chunked object can exhaust the inspector before it
 * ever completes. Comfortably above the backend's own inline threshold, so a
 * payload that legitimately spilled still fits; a payload beyond it is
 * reported unreadable, which is the honest answer and the same one a failed
 * fetch gives.
 */
const MAX_SPILLED_PAYLOAD_BYTES = 24 * 1024 * 1024;

export type EvidenceReadResult = {
  rows: EvidenceRow[];
  /** Whether pagination reached the end. False ⇒ the turn is incomplete. */
  exhausted: boolean;
  /**
   * Rows the backend returned that this reader could not parse — a status or
   * field shape it does not recognize, which on a backend-deploys-first
   * topology is exactly what version skew looks like. NOT folded into
   * `exhausted`: the read may well have reached the end, but a set with rows
   * missing from it must still fail the completeness check, or the calls
   * whose rows were dropped get graded as hallucinations the proxy in fact
   * recorded.
   */
  unparseableRows: number;
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

function readRows(payload: Record<string, unknown> | null): {
  rows: EvidenceRow[];
  dropped: number;
} {
  const raws = payload?.rows;
  if (!Array.isArray(raws)) return { rows: [], dropped: 0 };
  let dropped = 0;
  const rows = raws.flatMap((raw): EvidenceRow[] => {
    if (!raw || typeof raw !== "object") {
      dropped += 1;
      return [];
    }
    const row = raw as Record<string, unknown>;
    if (
      typeof row.requestId !== "string" ||
      typeof row.turnId !== "string" ||
      typeof row.serverId !== "string" ||
      typeof row.toolName !== "string" ||
      (row.status !== "started" && row.status !== "settled") ||
      typeof row.startedAtMs !== "number"
    ) {
      // A row this reader cannot understand is DROPPED — but COUNTED. The
      // old comment here claimed dropping was safe because the caller treats
      // a short read as incomplete; no caller ever did, and a dropped row
      // with `exhausted: true` read as a complete set with the row simply
      // absent. The count is what makes the hole visible to completeness.
      dropped += 1;
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
        argumentsUrl:
          typeof row.argumentsUrl === "string" ? row.argumentsUrl : null,
        status: row.status,
        outcomeKind:
          row.outcomeKind === "success" ||
          row.outcomeKind === "call_tool_error" ||
          row.outcomeKind === "jsonrpc_error"
            ? row.outcomeKind
            : null,
        responseJson:
          typeof row.responseJson === "string" ? row.responseJson : null,
        responseUrl:
          typeof row.responseUrl === "string" ? row.responseUrl : null,
        startedAtMs: row.startedAtMs,
        settledAtMs:
          typeof row.settledAtMs === "number" ? row.settledAtMs : null,
        payloadsReadable: row.payloadsReadable !== false,
      },
    ];
  });
  return { rows, dropped };
}

/** Whether a spill URL points at the deployment this inspector serves. */
function isTrustedPayloadUrl(url: string): boolean {
  const base = process.env.CONVEX_HTTP_URL?.trim();
  if (!base) return false;
  try {
    const target = new URL(url);
    // HTTPS only, and only the deployment this inspector is configured
    // against. The URL arrives in a service-token-authenticated response from
    // our own backend, so this is not the primary control — but it is a
    // server-side fetch of a URL that came over the wire, and pinning the
    // origin costs nothing. Compared on origin, not prefix: a `startsWith`
    // check treats `https://convex.example.evil.test` as a match.
    if (target.protocol !== "https:") return false;
    return target.origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * Read a body with a hard ceiling, without buffering past it.
 *
 * `response.text()` would decode whatever arrives before this function could
 * object, so the stream is consumed chunk by chunk and abandoned the moment it
 * exceeds the cap.
 */
async function readCappedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SPILLED_PAYLOAD_BYTES) {
    return null;
  }
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_SPILLED_PAYLOAD_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Fetch a payload the backend spilled to storage.
 *
 * Large payloads travel as URLs rather than inline because a page is bounded
 * by row count: inlining them made a turn with a few multi-megabyte tool
 * results exceed the response ceiling and become unreadable at ANY page size.
 * Fetching here is the cost of that, and it is bounded three ways — origin,
 * size and the pass's shared deadline — because a stalled or oversized blob
 * must degrade the turn to narration grading, not hang or exhaust the process
 * that is waiting on it.
 *
 * Every refusal returns null, which the caller turns into
 * `payloadsReadable: false`: a payload that cannot be read back is not
 * complete evidence, and reading it as empty would be the silent version of
 * exactly the loss this protocol makes visible.
 */
async function fetchSpilledPayload(
  url: string,
  deadlineAtMs: number,
): Promise<string | null> {
  if (!isTrustedPayloadUrl(url)) return null;
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) return null;
  try {
    const response = await fetch(url, {
      // Never follow a redirect: the origin was checked on THIS url, and a
      // 302 would move the fetch somewhere that check never saw.
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.min(PAYLOAD_FETCH_TIMEOUT_MS, remaining),
      ),
    });
    if (!response.ok) return null;
    return await readCappedText(response);
  } catch {
    return null;
  }
}

/**
 * Resolve every row's payloads, fetching the spilled ones.
 *
 * Sequential on purpose: the alternative is opening one connection per
 * payload for a turn that may hold dozens, and this runs after the turn has
 * already produced its answer — it is worth a little latency to not stampede
 * storage from every concurrent iteration at once.
 */
async function resolveSpilledPayloads(
  rows: EvidenceRow[],
  deadlineAtMs: number,
): Promise<EvidenceRow[]> {
  const resolved: EvidenceRow[] = [];
  for (const row of rows) {
    let { argumentsJson, responseJson, payloadsReadable } = row;
    if (argumentsJson === null && row.argumentsUrl) {
      argumentsJson = await fetchSpilledPayload(row.argumentsUrl, deadlineAtMs);
      if (argumentsJson === null) payloadsReadable = false;
    }
    if (responseJson === null && row.responseUrl) {
      responseJson = await fetchSpilledPayload(row.responseUrl, deadlineAtMs);
      if (responseJson === null) payloadsReadable = false;
    }
    // A SETTLED row with no payload and no URL to fetch one from. Both are
    // written by the same backend in the same mutation, so this is version
    // skew or a truncated write — and reading it as a successful call with an
    // empty response is precisely the silent loss this protocol exists to
    // make visible. Unreadable is the honest answer.
    //
    // Only `responseJson`: a settled call always produced one, whereas
    // `argumentsJson` is legitimately absent for a no-argument tool.
    if (row.status === "settled" && responseJson === null && !row.responseUrl) {
      payloadsReadable = false;
    }
    resolved.push({ ...row, argumentsJson, responseJson, payloadsReadable });
  }
  return resolved;
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
  let unparseableRows = 0;
  let cursor: string | null = null;
  // One deadline for the whole pass, set before the first request: payload
  // resolution is sequential, so only a shared budget bounds it.
  const deadlineAtMs = Date.now() + PAYLOAD_RESOLUTION_BUDGET_MS;

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
      return { rows, exhausted: false, unparseableRows };
    }

    if (response.status < 200 || response.status >= 300) {
      logger.warn("[harness-evidence] read returned an error status", {
        iterationId: args.iterationId,
        turnId: args.turnId,
        status: response.status,
      });
      return { rows, exhausted: false, unparseableRows };
    }

    const page = readRows(response.body);
    if (page.dropped > 0) {
      unparseableRows += page.dropped;
      logger.warn(
        "[harness-evidence] read returned rows this reader cannot parse",
        {
          iterationId: args.iterationId,
          turnId: args.turnId,
          dropped: page.dropped,
        },
      );
    }
    rows.push(...(await resolveSpilledPayloads(page.rows, deadlineAtMs)));

    if (response.body?.isDone === true) {
      return { rows, exhausted: true, unparseableRows };
    }
    const nextCursor = response.body?.cursor;
    if (typeof nextCursor !== "string" || nextCursor === cursor) {
      // No usable cursor and not done: the reader cannot advance, so it says
      // so rather than reporting what it happens to hold as the whole set.
      return { rows, exhausted: false, unparseableRows };
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
  return { rows, exhausted: false, unparseableRows };
}
