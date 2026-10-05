import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * The subset a rerun can narrow its source run to. `failed_cases`: every case
 * with a trial that did not complete and pass (cancelled and skipped trials do
 * not count). The BACKEND picks the cases (`convex/lib/evalRerun.ts`) and
 * stamps the new run `rerunOfRunId` + `rerunScope`; a caller only names the
 * scope.
 */
export type SuiteRerunScope = "failed_cases";

/**
 * The backend's rerun refusals, as readable route errors. Each one is raised
 * before any run row exists, and each names something the caller can act on,
 * so none of them should surface as an opaque 500.
 */
const RERUN_REFUSALS: Record<
  string,
  { status: 400 | 409; code: ErrorCode; fallback: string }
> = {
  RERUN_NOTHING_TO_RERUN: {
    status: 409,
    code: ErrorCode.CONFLICT,
    fallback:
      "Every case in that run passed (cancelled and skipped trials do not count), so there is nothing to rerun.",
  },
  RERUN_SOURCE_NOT_TERMINAL: {
    status: 409,
    code: ErrorCode.CONFLICT,
    fallback:
      "The run to rerun is still in progress; rerun it once it finishes.",
  },
  RERUN_SOURCE_SUITE_MISMATCH: {
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    fallback: "The run to rerun belongs to a different suite.",
  },
};

function refusal(
  reason: string,
  message: string | undefined,
  extra: Record<string, unknown> = {},
): WebRouteError {
  const entry = RERUN_REFUSALS[reason]!;
  return new WebRouteError(
    entry.status,
    entry.code,
    message && message.trim() ? message : entry.fallback,
    { ...extra, reason },
  );
}

/**
 * Translate a `startTestSuiteRun` rerun refusal (a `ConvexError` whose
 * `data.code` is one of the `RERUN_*` codes). Codes, not prose: the message is
 * the backend's and is forwarded verbatim, but the branch is on `code`.
 * Null for anything else, so a real fault stays a fault.
 */
export function rerunRefusalError(error: unknown): WebRouteError | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as {
    code?: unknown;
    message?: unknown;
    totalCaseCount?: unknown;
  };
  const code = typeof record.code === "string" ? record.code : undefined;
  if (!code || !RERUN_REFUSALS[code]) return null;
  return refusal(
    code,
    typeof record.message === "string" ? record.message : undefined,
    typeof record.totalCaseCount === "number"
      ? { totalCaseCount: record.totalCaseCount }
      : {},
  );
}

/**
 * The same two refusals the launch makes, decided from
 * `testSuites:getRerunPreview` BEFORE any server is connected. The launch
 * mutation decides again (the preview can go stale); this only spares the
 * caller a connection cycle for an answer that is already known.
 */
export function rerunPreviewRefusal(preview: {
  sourceTerminal?: unknown;
  sourceStatus?: unknown;
  rerunnable?: unknown;
  totalCaseCount?: unknown;
}): WebRouteError | null {
  if (preview.rerunnable === true) return null;
  const sourceStatus =
    typeof preview.sourceStatus === "string"
      ? { sourceStatus: preview.sourceStatus }
      : {};
  if (preview.sourceTerminal !== true) {
    return refusal("RERUN_SOURCE_NOT_TERMINAL", undefined, sourceStatus);
  }
  return refusal("RERUN_NOTHING_TO_RERUN", undefined, {
    ...sourceStatus,
    ...(typeof preview.totalCaseCount === "number"
      ? { totalCaseCount: preview.totalCaseCount }
      : {}),
  });
}
