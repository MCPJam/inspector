/**
 * The browser reads for materialized stage analytics (D5c) — a suite's runs as
 * a page, and one run's document on its own.
 *
 * TWO reads rather than one plus a filter. Paging a suite until a particular
 * run appears is unbounded work whose cost grows with how long ago the run
 * finished, and cannot answer once the run falls outside the pages walked. A
 * caller that already knows the run asks for the run.
 *
 * Same shape and the same reasons as `eval-run-decision-summary-api.ts`:
 * `PlatformApiClient` already speaks this endpoint with typed parameters and
 * URL encoding, so this wraps it rather than hand-rolling a second `fetch`, and
 * the transport strips the client's own `Authorization` header so `authFetch`
 * stays the ONE owner of the bearer (and keeps its 401 refresh-and-retry).
 *
 * ── What this module refuses to do ───────────────────────────────────────────
 *
 * It does not compute analytics. There is no client-side fallback that walks
 * iterations, scans traces, or reconstructs a denominator from a trial array:
 * a second derivation in the browser is a second reading of the run, and it
 * would produce numbers that disagree with the API's for reasons no one could
 * explain. If the backend cannot answer, this says so and the panel renders a
 * SERVICE state — never an empty chart, which reads as "measured, and it was
 * all zero".
 *
 * It also does not merge pages into one funnel. Each item is one run's complete
 * document and the SDK has no cross-run merge on purpose; summing them here
 * would be inventing a number the contract deliberately refuses to store.
 *
 * ── One caveat on `notFound` ─────────────────────────────────────────────────
 *
 * On the RUN read it means absence, not an error: the API answers the same 404
 * for "this run has no document" and "this run is not visible to you", on
 * purpose, so that the API cannot confirm the existence of runs in projects the
 * caller cannot see. A caller renders it as unmeasured.
 *
 * ── The four ways this can fail, kept apart ──────────────────────────────────
 *
 * `notFound`, `routeUnavailable`, `invalidContract` and `requestFailed` are
 * four different facts, and collapsing them into "couldn't load" loses the only
 * one a reader can act on. `invalidContract` in particular — the route answered
 * and the answer did not validate — is a bug report, not a network blip.
 */
import { PlatformApiClient, isPlatformApiError } from "@mcpjam/sdk/platform";
import {
  evalStageAnalyticsSchema,
  type EvalStageAnalyticsV1,
} from "@mcpjam/sdk/contract";
import { authFetch } from "@/lib/session-token";

/** Why a stage-analytics read did not produce documents. */
export type StageAnalyticsFailureKind =
  /** The route answered 404: this project has no such suite (or cannot see it). */
  | "notFound"
  /** The deployment does not serve the stage-analytics contract at all. */
  | "routeUnavailable"
  /** The route answered and the payload did not validate against the contract. */
  | "invalidContract"
  /** Network, timeout, auth, 5xx — the read did not complete. */
  | "requestFailed";

export class EvalStageAnalyticsError extends Error {
  readonly kind: StageAnalyticsFailureKind;
  readonly status?: number;

  constructor(
    kind: StageAnalyticsFailureKind,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : {},
    );
    this.name = "EvalStageAnalyticsError";
    this.kind = kind;
    this.status = options?.status;
  }
}

export function isEvalStageAnalyticsError(
  error: unknown,
): error is EvalStageAnalyticsError {
  return error instanceof EvalStageAnalyticsError;
}

/** One page of per-run documents, newest run completion first. */
export interface EvalStageAnalyticsPage {
  rows: EvalStageAnalyticsV1[];
  /** Absent means this was the last page — completeness is this field's absence. */
  nextCursor?: string;
}

const stageAnalyticsFetch: typeof fetch = (input, init) => {
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
    // Empty on purpose — `stageAnalyticsFetch` strips it and `authFetch`
    // supplies the real one, so the bearer has exactly one owner.
    getAuth: () => "",
    fetch: stageAnalyticsFetch,
  });
}

/**
 * A deployment that predates the stage-analytics route, as opposed to a suite
 * that is not there.
 *
 * `FEATURE_NOT_SUPPORTED` and `501` are the two ways an API says "this build
 * does not serve that"; `405` is the same answer from a router that knows the
 * path shape but not this method. Everything else at 404 is the route's own
 * "Eval suite not found", which is a fact about the suite.
 */
function isRouteUnavailable(status: number, code: string): boolean {
  return (
    code === "FEATURE_NOT_SUPPORTED" ||
    code === "NOT_IMPLEMENTED" ||
    status === 501 ||
    status === 405
  );
}

export async function fetchEvalSuiteStageAnalytics(
  params: {
    projectId: string;
    suiteId: string;
    /** Inclusive epoch ms over `runCompletedAt`. */
    from?: number;
    to?: number;
    runGroupId?: string;
    cursor?: string;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<EvalStageAnalyticsPage> {
  let raw: unknown;
  try {
    raw = await client().listEvalSuiteStageAnalytics(
      {
        projectId: params.projectId,
        suiteId: params.suiteId,
        ...(params.from !== undefined ? { from: params.from } : {}),
        ...(params.to !== undefined ? { to: params.to } : {}),
        ...(params.runGroupId ? { runGroupId: params.runGroupId } : {}),
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      },
      { signal },
    );
  } catch (error) {
    // A caller's abort is the caller's, not a failure of the read. Rethrow it
    // untouched so the controller can tell "we cancelled this" from "the API
    // said no".
    if (signal?.aborted) throw error;
    if (isPlatformApiError(error)) {
      if (isRouteUnavailable(error.status, error.code)) {
        throw new EvalStageAnalyticsError(
          "routeUnavailable",
          "This deployment does not serve eval stage analytics.",
          { status: error.status, cause: error },
        );
      }
      if (error.status === 404) {
        throw new EvalStageAnalyticsError("notFound", error.message, {
          status: error.status,
          cause: error,
        });
      }
      throw new EvalStageAnalyticsError("requestFailed", error.message, {
        status: error.status,
        cause: error,
      });
    }
    throw new EvalStageAnalyticsError(
      "requestFailed",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  const envelope = raw as { items?: unknown; nextCursor?: unknown } | null;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !Array.isArray(envelope.items)
  ) {
    throw new EvalStageAnalyticsError(
      "invalidContract",
      "The stage analytics response was not a page envelope.",
    );
  }
  if (
    envelope.nextCursor !== undefined &&
    typeof envelope.nextCursor !== "string"
  ) {
    throw new EvalStageAnalyticsError(
      "invalidContract",
      "The stage analytics page cursor was not a string.",
    );
  }

  const rows: EvalStageAnalyticsV1[] = [];
  for (const item of envelope.items) {
    // Parsed HERE rather than trusted from the wire, with the REFINED schema —
    // the structural one would admit a document with two `overall` slices or an
    // overall slice that disagrees with the row's own trial count, and those
    // are exactly the invariants every number below rests on.
    const parsed = evalStageAnalyticsSchema.safeParse(item);
    if (!parsed.success) {
      throw new EvalStageAnalyticsError(
        "invalidContract",
        "A stage analytics document did not match the published contract.",
        { cause: parsed.error },
      );
    }
    // Shape is not identity. `suiteId` is only `string().min(1)` to the schema,
    // so a valid document for a DIFFERENT suite parses perfectly — and would
    // then render under this suite's heading as its funnel. Nothing upstream
    // binds the answer to the question; this does.
    if (parsed.data.suiteId !== params.suiteId) {
      throw new EvalStageAnalyticsError(
        "invalidContract",
        "A stage analytics document is for a different suite than the one requested.",
      );
    }
    rows.push(parsed.data as EvalStageAnalyticsV1);
  }

  return {
    rows,
    ...(typeof envelope.nextCursor === "string"
      ? { nextCursor: envelope.nextCursor }
      : {}),
  };
}

/**
 * ONE run's document, addressed by run.
 *
 * A separate read from the suite listing rather than a filter over it. Paging
 * a suite until a particular run appears is unbounded work whose cost grows
 * with how long ago the run finished, and it cannot answer at all once the run
 * falls outside the page walked — a run detail page already knows its run and
 * should ask for it.
 *
 * `notFound` here is ABSENCE, not an error to shout about: the API deliberately
 * gives the same answer for "no document" and "not visible", so a caller must
 * render it as unmeasured rather than as a failure. The other three kinds keep
 * the meanings they have in the listing.
 */
export async function fetchEvalRunStageAnalytics(
  params: { projectId: string; runId: string },
  signal?: AbortSignal,
): Promise<EvalStageAnalyticsV1> {
  let raw: unknown;
  try {
    raw = await client().getEvalRunStageAnalytics(
      { projectId: params.projectId, runId: params.runId },
      { signal },
    );
  } catch (error) {
    // A caller's abort is the caller's, not a failure of the read.
    if (signal?.aborted) throw error;
    if (isPlatformApiError(error)) {
      if (isRouteUnavailable(error.status, error.code)) {
        throw new EvalStageAnalyticsError(
          "routeUnavailable",
          "This deployment does not serve eval stage analytics.",
          { status: error.status, cause: error },
        );
      }
      if (error.status === 404) {
        throw new EvalStageAnalyticsError("notFound", error.message, {
          status: error.status,
          cause: error,
        });
      }
      throw new EvalStageAnalyticsError("requestFailed", error.message, {
        status: error.status,
        cause: error,
      });
    }
    throw new EvalStageAnalyticsError(
      "requestFailed",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  // Parsed HERE with the REFINED schema, exactly as the listing does. The route
  // validates too; this is not redundant, because the browser is where the
  // numbers get drawn and a document that reached it through any other path
  // (a cache, a future transport) must meet the same bar.
  const parsed = evalStageAnalyticsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EvalStageAnalyticsError(
      "invalidContract",
      "The stage analytics document did not match the published contract.",
      { cause: parsed.error },
    );
  }
  // Shape is not identity — the same binding the suite read makes on `suiteId`.
  if (parsed.data.runId !== params.runId) {
    throw new EvalStageAnalyticsError(
      "invalidContract",
      "The stage analytics document is for a different run than the one requested.",
    );
  }
  return parsed.data as EvalStageAnalyticsV1;
}
