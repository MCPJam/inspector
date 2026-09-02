/**
 * The browser read for "what changed since the last run".
 *
 * Same shape and the same reasons as `eval-run-decision-summary-api.ts`:
 * `PlatformApiClient` already speaks this endpoint with typed parameters and
 * URL encoding, and the transport strips the client's own `Authorization`
 * header so `authFetch` stays the one owner of the bearer.
 *
 * ── Why the public route rather than the Convex action ───────────────────────
 *
 * `run-diff-view.tsx` reaches the same diff through `useAction` on
 * `testSuites:getTestSuiteRunDiff`, typed by a hand-mirrored interface. That
 * works and is not being changed. This read is new, and a new consumer should
 * take the published DTO: the server resolves `previous_completed` itself
 * (which is the bounded, correct query), the payload is validated at the
 * boundary here, and the failure modes arrive as distinct kinds instead of one
 * thrown value.
 *
 * ── Five failures, kept apart ────────────────────────────────────────────────
 *
 * `noBaseline` is the one that matters most and the one a collapsed error would
 * lose: a suite's FIRST run has nothing to compare against, which is an
 * ordinary and permanent fact about that run, not a failure. It renders as no
 * pill at all. `requestFailed` renders as no pill either — but for a different
 * reason, and never as "unchanged", which would assert a comparison nobody
 * made.
 */
import { PlatformApiClient, isPlatformApiError } from "@mcpjam/sdk/platform";
import { z } from "zod";

import { authFetch } from "@/lib/session-token";

export type EvalRunCompareFailureKind =
  /** This run has no earlier completed run to compare against. */
  | "noBaseline"
  /** The route answered 404: no such run in this project. */
  | "notFound"
  /** The deployment does not serve the compare route at all. */
  | "routeUnavailable"
  /** The route answered and the payload did not validate. */
  | "invalidContract"
  /** Network, timeout, auth, 5xx — the read did not complete. */
  | "requestFailed";

export class EvalRunCompareError extends Error {
  readonly kind: EvalRunCompareFailureKind;
  readonly status?: number;

  constructor(
    kind: EvalRunCompareFailureKind,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : {},
    );
    this.name = "EvalRunCompareError";
    this.kind = kind;
    this.status = options?.status;
  }
}

export function isEvalRunCompareError(
  error: unknown,
): error is EvalRunCompareError {
  return error instanceof EvalRunCompareError;
}

export const EVAL_RUN_COMPARE_CASE_STATUSES = [
  "unchanged_passed",
  "unchanged_failed",
  "regressed",
  "fixed",
  "new_case",
  "removed_case",
  "changed",
] as const;

export type EvalRunCompareCaseStatus =
  (typeof EVAL_RUN_COMPARE_CASE_STATUSES)[number];

/**
 * Only the fields this page renders, and `passthrough` for the rest.
 *
 * Narrow on purpose: a schema that mirrored the whole DTO would reject a
 * perfectly good response the day the API adds a field, and this surface has no
 * use for score contracts, skills or previews.
 */
const caseSideSchema = z
  .object({
    outcome: z.enum(["passed", "failed", "absent"]),
    iterationIds: z.array(z.string()).default([]),
  })
  .passthrough();

export const evalRunCompareSchema = z
  .object({
    baseline: z.object({ baseRunId: z.string().min(1) }).passthrough(),
    baseRun: z
      .object({ id: z.string().min(1), runNumber: z.number() })
      .passthrough(),
    compareRun: z
      .object({ id: z.string().min(1), runNumber: z.number() })
      .passthrough(),
    cases: z.array(
      z
        .object({
          caseKey: z.string().min(1),
          title: z.string(),
          status: z.enum(EVAL_RUN_COMPARE_CASE_STATUSES),
          configChanged: z.boolean().optional(),
          evaluationConfigChanged: z.boolean().optional(),
          base: caseSideSchema,
          compare: caseSideSchema,
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type EvalRunCompareDto = z.infer<typeof evalRunCompareSchema>;

const compareFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return authFetch(input as Parameters<typeof authFetch>[0], {
    ...init,
    headers,
  });
};

function client(): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "/api/v1",
    getAuth: () => "",
    fetch: compareFetch,
  });
}

function isRouteUnavailable(status: number, code: string): boolean {
  return (
    code === "FEATURE_NOT_SUPPORTED" ||
    code === "NOT_IMPLEMENTED" ||
    status === 501 ||
    status === 405
  );
}

function isMissingBaseline(error: {
  status: number;
  details?: unknown;
}): boolean {
  if (error.status !== 404) return false;
  const details = error.details as { reason?: unknown } | undefined;
  return details?.reason === "BASELINE_NOT_FOUND";
}

export async function fetchEvalRunCompare(
  params: { projectId: string; runId: string; baseRunId?: string },
  signal?: AbortSignal,
): Promise<EvalRunCompareDto> {
  let raw: unknown;
  try {
    raw = await client().compareEvalRun(
      {
        projectId: params.projectId,
        runId: params.runId,
        ...(params.baseRunId ? { baseRunId: params.baseRunId } : {}),
      },
      { signal },
    );
  } catch (error) {
    // A caller's abort is the caller's, not a failure of the read.
    if (signal?.aborted) throw error;
    if (isPlatformApiError(error)) {
      if (isMissingBaseline(error)) {
        throw new EvalRunCompareError(
          "noBaseline",
          "This run has no earlier completed run to compare against.",
          { status: error.status, cause: error },
        );
      }
      if (isRouteUnavailable(error.status, error.code)) {
        throw new EvalRunCompareError(
          "routeUnavailable",
          "This deployment does not serve run comparisons.",
          { status: error.status, cause: error },
        );
      }
      if (error.status === 404) {
        throw new EvalRunCompareError("notFound", error.message, {
          status: error.status,
          cause: error,
        });
      }
      throw new EvalRunCompareError("requestFailed", error.message, {
        status: error.status,
        cause: error,
      });
    }
    throw new EvalRunCompareError(
      "requestFailed",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  const parsed = evalRunCompareSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EvalRunCompareError(
      "invalidContract",
      "The run comparison did not match the published contract.",
      { cause: parsed.error },
    );
  }
  // Shape is not identity. A valid comparison for a DIFFERENT run parses
  // perfectly and would then paint this run's rows with another run's changes.
  if (parsed.data.compareRun.id !== params.runId) {
    throw new EvalRunCompareError(
      "invalidContract",
      "The run comparison is for a different run than the one requested.",
    );
  }
  return parsed.data;
}
