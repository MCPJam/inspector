import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

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
      "Nothing in that run qualifies (no trial failed; cancelled and skipped trials do not count).",
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

/** The backend's trial counts that did not qualify, numbers only. */
function excludedCounts(value: unknown): { excluded?: Record<string, number> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const counts = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
  return Object.keys(counts).length > 0 ? { excluded: counts } : {};
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
    excluded?: unknown;
  };
  const code = typeof record.code === "string" ? record.code : undefined;
  if (!code || !RERUN_REFUSALS[code]) return null;
  return refusal(
    code,
    typeof record.message === "string" ? record.message : undefined,
    {
      ...(typeof record.totalCaseCount === "number"
        ? { totalCaseCount: record.totalCaseCount }
        : {}),
      ...excludedCounts(record.excluded),
    },
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
  excluded?: unknown;
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
    ...excludedCounts(preview.excluded),
  });
}
