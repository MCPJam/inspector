import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * The backend's resume refusals, as readable route errors. `startTestSuiteRun`
 * raises one when a `resumeFromRunId` launch cannot resume, before any run row
 * exists, and each names something the caller can act on — so none should
 * surface as an opaque 500, and each maps to a status the CLI reads as a usage
 * problem (exit 2), never as a credit block (exit 6).
 */
const RESUME_REFUSALS: Record<
  string,
  { status: 400 | 404 | 409; code: ErrorCode; fallback: string }
> = {
  RESUME_NOTHING_TO_RESUME: {
    status: 409,
    code: ErrorCode.CONFLICT,
    fallback:
      "That run has no unfinished cases to resume; every case already completed.",
  },
  RESUME_SOURCE_NOT_FOUND: {
    status: 404,
    code: ErrorCode.NOT_FOUND,
    fallback: "The run to resume was not found.",
  },
  RESUME_SOURCE_STILL_RUNNING: {
    status: 409,
    code: ErrorCode.CONFLICT,
    fallback: "The run to resume is still in progress; resume it once it stops.",
  },
  RESUME_SCOPE_CONFLICT: {
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    fallback:
      "Resuming a run cannot be combined with selecting targets or cases; resume runs the source run's own unfinished cases.",
  },
};

/**
 * Translate a `startTestSuiteRun` resume refusal (a `ConvexError` whose
 * `data.code` is one of the `RESUME_*` codes). Codes, not prose: the message is
 * the backend's and is forwarded verbatim, but the branch is on `code`. Null
 * for anything else, so a real fault stays a fault.
 */
export function resumeRefusalError(error: unknown): WebRouteError | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as { code?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : undefined;
  if (!code || !RESUME_REFUSALS[code]) return null;
  const entry = RESUME_REFUSALS[code]!;
  return new WebRouteError(
    entry.status,
    entry.code,
    typeof record.message === "string" && record.message.trim()
      ? record.message
      : entry.fallback,
    { reason: code },
  );
}
