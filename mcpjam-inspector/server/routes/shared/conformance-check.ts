/**
 * Reading a stored conformance run check by check: the pages of its failing
 * checks, and one check in full.
 *
 * Pages cover a FINISHED run only. A running run's reports are still being
 * written, so an offset into its failures would skip or repeat checks as they
 * land; its first page is served, with no cursor to a second.
 */
import { ErrorCode, WebRouteError } from "../web/errors.js";

/** Statuses after which a run's stored reports no longer change. */
const FINISHED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "timed_out",
  "cancelled",
]);

/** The most of a check's `details` or `output` one read returns. */
export const CONFORMANCE_CHECK_FIELD_CAP = 16 * 1024;

const STALE_CURSOR =
  "This cursor does not belong to this run's report. Read the report again without a cursor.";

function encodeCursor(runId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ run: runId, offset })).toString(
    "base64url",
  );
}

function decodeCursor(runId: string, cursor: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    // Not a cursor this route issued: the same refusal as one for another run.
    parsed = undefined;
  }
  const offset = (parsed as { offset?: unknown } | undefined)?.offset;
  if (
    (parsed as { run?: unknown } | undefined)?.run !== runId ||
    typeof offset !== "number" ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, STALE_CURSOR);
  }
  return offset;
}

/**
 * One page of a run's failing checks, in the projection's order, and the
 * cursor to the next page when there is one.
 */
export function pageFailingChecks<T>(
  run: { id: string; status: string },
  failing: readonly T[],
  pageSize: number,
  cursor: string | undefined,
): { checks: T[]; more: boolean; nextCursor?: string } {
  const finished = FINISHED_RUN_STATUSES.has(run.status);
  if (cursor !== undefined && !finished) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "This run is still running, so its failing checks can still change. Read the report again once the run finishes.",
    );
  }
  const offset = cursor === undefined ? 0 : decodeCursor(run.id, cursor);
  const checks = failing.slice(offset, offset + pageSize);
  const next = offset + checks.length;
  return {
    checks,
    more: next < failing.length,
    ...(finished && next < failing.length
      ? { nextCursor: encodeCursor(run.id, next) }
      : {}),
  };
}

export interface ConformanceCheckDetail {
  runId: string;
  suiteKind: string;
  id: string;
  title: string;
  category: string;
  status: string;
  skipReason?: string;
  pending: boolean;
  durationMs: number | null;
  description?: string;
  error?: string;
  /** The stored details; past the cap, the start of their JSON text. */
  details?: unknown;
  output?: string;
  truncated: { details: boolean; output: boolean };
}

/** Cut at the cap in UTF-8 bytes, never inside a character. */
function capText(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= CONFORMANCE_CHECK_FIELD_CAP) {
    return { text, truncated: false };
  }
  let end = CONFORMANCE_CHECK_FIELD_CAP;
  // A continuation byte (10xxxxxx) here means the cut splits a character.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function casesOf(report: unknown): Record<string, unknown>[] {
  const groups = (report as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    const cases = (group as { cases?: unknown } | null)?.cases;
    return Array.isArray(cases)
      ? cases.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null,
        )
      : [];
  });
}

/**
 * One check of a run, from its stored suite reports. `suite` is needed only
 * when the same id is in two suites of the run.
 */
export function findConformanceCheck(
  runId: string,
  suiteReports: { suiteKind: string; report: unknown }[],
  checkId: string,
  suite: string | undefined,
): ConformanceCheckDetail {
  const matches = suiteReports
    .filter((entry) => suite === undefined || entry.suiteKind === suite)
    .flatMap((entry) =>
      casesOf(entry.report)
        .filter((rec) => rec.id === checkId)
        .map((rec) => ({ suiteKind: entry.suiteKind, rec })),
    );
  if (matches.length === 0) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      `This run has no check "${checkId}"${suite ? ` in its ${suite} suite` : ""}. List its failing checks with the report endpoint to find their ids.`,
    );
  }
  const suites = [...new Set(matches.map((match) => match.suiteKind))];
  if (suites.length > 1) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Check "${checkId}" is in more than one suite of this run (${suites.join(", ")}). Name one with suite.`,
    );
  }
  const { suiteKind, rec } = matches[0]!;
  const details =
    rec.details === undefined
      ? undefined
      : capText(JSON.stringify(rec.details));
  const output =
    typeof rec.output === "string" ? capText(rec.output) : undefined;
  const text = (key: string) =>
    typeof rec[key] === "string" ? { [key]: rec[key] as string } : {};
  return {
    runId,
    suiteKind,
    id: checkId,
    title: String(rec.title ?? checkId),
    category: String(rec.category ?? ""),
    status: String(rec.status ?? ""),
    ...text("skipReason"),
    pending: rec.pending === true,
    durationMs: typeof rec.durationMs === "number" ? rec.durationMs : null,
    ...text("description"),
    ...text("error"),
    ...(details
      ? { details: details.truncated ? details.text : rec.details }
      : {}),
    ...(output ? { output: output.text } : {}),
    truncated: {
      details: details?.truncated ?? false,
      output: output?.truncated ?? false,
    },
  };
}
