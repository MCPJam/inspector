/**
 * The browser read for one run's materialized route facts.
 *
 * Same shape and the same reasons as `eval-stage-analytics-api.ts`:
 * `PlatformApiClient` already speaks this endpoint with typed parameters and
 * URL encoding, so this wraps it rather than hand-rolling a second `fetch`, and
 * the transport strips the client's own `Authorization` header so `authFetch`
 * stays the ONE owner of the bearer (and keeps its 401 refresh-and-retry).
 *
 * ── What this module refuses to do ───────────────────────────────────────────
 *
 * It does not compute route facts. There is no reconstruction in this adapter:
 * a second derivation in the browser is a second reading of the run. If the
 * backend cannot answer, this says so. The evaluate run page may fall back to
 * the client producer; that decision lives there, not here.
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
  evalRunRouteFactsSchema,
  type EvalRunRouteFacts,
} from "@mcpjam/sdk/contract";
import { authFetch } from "@/lib/session-token";

/** Why a route-facts read did not produce a document. */
export type RouteFactsFailureKind =
  /** The route answered 404: this project has no such run (or cannot see it). */
  | "notFound"
  /** The deployment does not serve the route-facts contract at all. */
  | "routeUnavailable"
  /** The route answered and the payload did not validate against the contract. */
  | "invalidContract"
  /** Network, timeout, auth, 5xx — the read did not complete. */
  | "requestFailed";

export class EvalRouteFactsError extends Error {
  readonly kind: RouteFactsFailureKind;
  readonly status?: number;

  constructor(
    kind: RouteFactsFailureKind,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : {},
    );
    this.name = "EvalRouteFactsError";
    this.kind = kind;
    this.status = options?.status;
  }
}

export function isEvalRouteFactsError(
  error: unknown,
): error is EvalRouteFactsError {
  return error instanceof EvalRouteFactsError;
}

const routeFactsFetch: typeof fetch = (input, init) => {
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
    // Empty on purpose — `routeFactsFetch` strips it and `authFetch`
    // supplies the real one, so the bearer has exactly one owner.
    getAuth: () => "",
    fetch: routeFactsFetch,
  });
}

/**
 * A deployment that predates the route-facts route, as opposed to a run
 * that is not there.
 *
 * `FEATURE_NOT_SUPPORTED` and `501` are the two ways an API says "this build
 * does not serve that"; `405` is the same answer from a router that knows the
 * path shape but not this method. Everything else at 404 is the route's own
 * "Eval run route facts not found", which is a fact about the run.
 */
function isRouteUnavailable(
  status: number,
  code: string,
  codeSource?: "envelope" | "status",
): boolean {
  return (
    code === "FEATURE_NOT_SUPPORTED" ||
    code === "NOT_IMPLEMENTED" ||
    status === 501 ||
    status === 405 ||
    (status === 404 && codeSource === "status")
  );
}

/**
 * ONE run's document, addressed by run.
 *
 * `notFound` here is ABSENCE, not an error to shout about: the API deliberately
 * gives the same answer for "no document" and "not visible", so a caller must
 * render it as unmeasured rather than as a failure. The other three kinds keep
 * the meanings they have in the stage-analytics sibling.
 */
export async function fetchEvalRunRouteFacts(
  params: { projectId: string; runId: string },
  signal?: AbortSignal,
): Promise<EvalRunRouteFacts> {
  let raw: unknown;
  try {
    raw = await client().getEvalRunRouteFacts(
      { projectId: params.projectId, runId: params.runId },
      { signal },
    );
  } catch (error) {
    // A caller's abort is the caller's, not a failure of the read.
    if (signal?.aborted) throw error;
    if (isPlatformApiError(error)) {
      if (isRouteUnavailable(error.status, error.code, error.codeSource)) {
        throw new EvalRouteFactsError(
          "routeUnavailable",
          "This deployment does not serve eval run route facts.",
          { status: error.status, cause: error },
        );
      }
      if (error.status === 404) {
        throw new EvalRouteFactsError("notFound", error.message, {
          status: error.status,
          cause: error,
        });
      }
      throw new EvalRouteFactsError("requestFailed", error.message, {
        status: error.status,
        cause: error,
      });
    }
    throw new EvalRouteFactsError(
      "requestFailed",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  const parsed = evalRunRouteFactsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EvalRouteFactsError(
      "invalidContract",
      "The route facts document did not match the published contract.",
      { cause: parsed.error },
    );
  }
  if (parsed.data.runId !== params.runId) {
    throw new EvalRouteFactsError(
      "invalidContract",
      "The route facts document is for a different run than the one requested.",
    );
  }
  return parsed.data;
}
