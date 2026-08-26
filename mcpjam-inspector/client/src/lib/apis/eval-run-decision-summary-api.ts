/**
 * The browser read for D9's canonical eval run decision summary.
 *
 * Same shape and the same reasons as `eval-disclosure-api.ts`:
 * `PlatformApiClient` already speaks this endpoint with typed parameters and
 * URL encoding, so this wraps it rather than hand-rolling a second `fetch`,
 * and the transport strips the client's own `Authorization` header so
 * `authFetch` stays the ONE owner of the bearer (and keeps its 401
 * refresh-and-retry). See that module's header for the full reasoning.
 *
 * ── What this module refuses to do ───────────────────────────────────────────
 *
 * It does not assemble. The first-party route is live, so there is no
 * client-side fallback that walks iterations and builds a summary locally: a
 * second assembler in the browser is a second reading of the run, which is the
 * exact failure D9 exists to end. If the route answers badly, this says so and
 * the surface renders a state — it never invents a verdict.
 *
 * It also never resolves a project. `projectId` is threaded down from
 * `EvaluateTab`, which already has it; guessing one in the browser (or reading
 * it back out of a run id) is how a run gets read against the wrong project.
 *
 * ── The four ways this can fail, kept apart ──────────────────────────────────
 *
 * `notFound`, `routeUnavailable`, `invalidContract` and `requestFailed` are
 * four different facts about a run, and collapsing them into "couldn't load"
 * loses the only one a reader can act on. In particular `invalidContract` —
 * the route answered, and the answer did not validate — is a bug report, not a
 * network blip, and it must never render as an absent summary.
 */
import { PlatformApiClient, isPlatformApiError } from "@mcpjam/sdk/platform";
import {
  evalRunDecisionSummarySchema,
  type EvalRunDecisionSummary,
} from "@mcpjam/sdk/contract";
import { authFetch } from "@/lib/session-token";

/** Why a decision-summary read did not produce a summary. */
export type DecisionSummaryFailureKind =
  /** The route answered 404: this project has no such run (or cannot see it). */
  | "notFound"
  /** The deployment does not serve the decision-summary contract at all. */
  | "routeUnavailable"
  /** The route answered and the payload did not validate against the contract. */
  | "invalidContract"
  /** Network, timeout, auth, 5xx — the read did not complete. */
  | "requestFailed";

export class EvalRunDecisionSummaryError extends Error {
  readonly kind: DecisionSummaryFailureKind;
  readonly status?: number;

  constructor(
    kind: DecisionSummaryFailureKind,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : {});
    this.name = "EvalRunDecisionSummaryError";
    this.kind = kind;
    this.status = options?.status;
  }
}

export function isEvalRunDecisionSummaryError(
  error: unknown,
): error is EvalRunDecisionSummaryError {
  return error instanceof EvalRunDecisionSummaryError;
}

const decisionSummaryFetch: typeof fetch = (input, init) => {
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
    // Empty on purpose — `decisionSummaryFetch` strips it and `authFetch`
    // supplies the real one, so the bearer has exactly one owner.
    getAuth: () => "",
    fetch: decisionSummaryFetch,
  });
}

/**
 * A deployment that predates the decision-summary route, as opposed to a run
 * that is not there.
 *
 * `FEATURE_NOT_SUPPORTED` and `501` are the two ways an API says "this build
 * does not serve that"; `405` is the same answer from a router that knows the
 * path shape but not this method. Everything else at 404 is the route's own
 * "Eval run not found", which is a fact about the run.
 */
function isRouteUnavailable(status: number, code: string): boolean {
  return (
    code === "FEATURE_NOT_SUPPORTED" ||
    code === "NOT_IMPLEMENTED" ||
    status === 501 ||
    status === 405
  );
}

export async function fetchEvalRunDecisionSummary(
  params: {
    projectId: string;
    runId: string;
    /** Diagnostics cursor. A page reached through one is never `complete`. */
    cursor?: string;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<EvalRunDecisionSummary> {
  let raw: unknown;
  try {
    raw = await client().getEvalRunDecisionSummary(
      {
        projectId: params.projectId,
        runId: params.runId,
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
        throw new EvalRunDecisionSummaryError(
          "routeUnavailable",
          "This deployment does not serve run decision summaries.",
          { status: error.status, cause: error },
        );
      }
      if (error.status === 404) {
        throw new EvalRunDecisionSummaryError("notFound", error.message, {
          status: error.status,
          cause: error,
        });
      }
      throw new EvalRunDecisionSummaryError("requestFailed", error.message, {
        status: error.status,
        cause: error,
      });
    }
    throw new EvalRunDecisionSummaryError(
      "requestFailed",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  // Parsed HERE rather than trusted from the wire. The contract is the whole
  // point of this surface: rendering an unvalidated payload would put a
  // verdict on screen that nothing checked against the decision beside it.
  const parsed = evalRunDecisionSummarySchema.safeParse(raw);
  if (!parsed.success) {
    throw new EvalRunDecisionSummaryError(
      "invalidContract",
      "The run decision summary did not match the published contract.",
      { cause: parsed.error },
    );
  }
  // Shape is not identity. `runId` is only `string().min(1)` to the schema, so
  // a valid summary for a DIFFERENT run parses perfectly — and would then be
  // cached under this run's key, render its verdict and counts, and hand the
  // trace control a foreign iteration to navigate to. Nothing upstream binds
  // the answer to the question; this does. A healthy server always echoes the
  // id it was asked about (the route reads `run.id` from the run it fetched by
  // that id), so this can only fire on a response that genuinely is not the
  // one requested.
  if (parsed.data.runId !== params.runId) {
    throw new EvalRunDecisionSummaryError(
      "invalidContract",
      "The run decision summary is for a different run than the one requested.",
    );
  }
  return parsed.data;
}
