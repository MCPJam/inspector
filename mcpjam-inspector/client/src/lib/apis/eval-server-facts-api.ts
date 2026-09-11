/**
 * The browser read for one run's SERVER FACTS.
 *
 * The sibling of `eval-route-facts-api.ts`, and shaped the same way for the
 * same reasons: `PlatformApiClient` already speaks this endpoint with typed
 * parameters and URL encoding, and the transport strips the client's own
 * `Authorization` header so `authFetch` stays the ONE owner of the bearer
 * (and keeps its 401 refresh-and-retry).
 *
 * ── ONE DIFFERENCE FROM ROUTE FACTS, AND IT MATTERS ──────────────────────────
 *
 * Server facts are COMPUTED ON READ. There is no materializer, no backfill
 * window, and therefore no "this run has no document" state: a run with no
 * snapshot answers `state: "unavailable"` with a reason, inside a valid
 * document. So a 404 here means one thing only — the run is not visible to
 * this caller — and `notFound` is not the routine answer it is for route
 * facts.
 *
 * ── The four ways this can fail, kept apart ──────────────────────────────────
 *
 * `notFound`, `routeUnavailable`, `invalidContract` and `requestFailed` are
 * four different facts. `invalidContract` in particular — the route answered
 * and the answer did not validate — means the backend builder and this
 * contract have drifted, which is a bug report rather than a network blip.
 */
import { PlatformApiClient, isPlatformApiError } from "@mcpjam/sdk/platform";
import {
  evalRunServerFactsSchema,
  type EvalRunServerFactsV1,
} from "@mcpjam/sdk/contract";
import { authFetch } from "@/lib/session-token";

/** Why a server-facts read did not produce a document. */
export type ServerFactsFailureKind =
  /** The route answered 404: this project has no such run (or cannot see it). */
  | "notFound"
  /** The deployment does not serve the server-facts contract at all. */
  | "routeUnavailable"
  /** The route answered and the payload did not validate against the contract. */
  | "invalidContract"
  /** Network, timeout, auth, 5xx — the read did not complete. */
  | "requestFailed";

export class EvalServerFactsError extends Error {
  readonly kind: ServerFactsFailureKind;
  readonly status?: number;

  constructor(
    kind: ServerFactsFailureKind,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : {},
    );
    this.name = "EvalServerFactsError";
    this.kind = kind;
    this.status = options?.status;
  }
}

export function isEvalServerFactsError(
  error: unknown,
): error is EvalServerFactsError {
  return error instanceof EvalServerFactsError;
}

const serverFactsFetch: typeof fetch = (input, init) => {
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
    // Empty on purpose — `serverFactsFetch` strips it and `authFetch`
    // supplies the real one, so the bearer has exactly one owner.
    getAuth: () => "",
    fetch: serverFactsFetch,
  });
}

/**
 * A deployment that predates the server-facts route, as opposed to a run that
 * is not visible.
 *
 * `FEATURE_NOT_SUPPORTED` and `501` are the two ways an API says "this build
 * does not serve that"; `405` is the same answer from a router that knows the
 * path shape but not this method; a 404 whose code came from the STATUS rather
 * than an error envelope is a router that has never heard of the path at all.
 * A 404 carrying the route's own envelope is a fact about visibility.
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

/** ONE run's server-facts document, addressed by run. */
export async function fetchEvalRunServerFacts(
  params: { projectId: string; runId: string },
  signal?: AbortSignal,
): Promise<EvalRunServerFactsV1> {
  let raw: unknown;
  try {
    raw = await client().getEvalRunServerFacts(
      { projectId: params.projectId, runId: params.runId },
      { signal },
    );
  } catch (error) {
    // A caller's abort is the caller's, not a failure of the read.
    if (signal?.aborted) throw error;
    if (isPlatformApiError(error)) {
      if (isRouteUnavailable(error.status, error.code, error.codeSource)) {
        throw new EvalServerFactsError(
          "routeUnavailable",
          "This deployment does not serve eval run server facts.",
          { status: error.status, cause: error },
        );
      }
      if (error.status === 404) {
        throw new EvalServerFactsError("notFound", error.message, {
          status: error.status,
          cause: error,
        });
      }
      throw new EvalServerFactsError("requestFailed", error.message, {
        status: error.status,
        cause: error,
      });
    }
    throw new EvalServerFactsError(
      "requestFailed",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  const parsed = evalRunServerFactsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EvalServerFactsError(
      "invalidContract",
      "The server facts document did not match the published contract.",
      { cause: parsed.error },
    );
  }
  if (parsed.data.runId !== params.runId) {
    // Not a cosmetic check: rendering another run's tool surface beside this
    // run's verdict is a wrong answer that looks like a right one.
    throw new EvalServerFactsError(
      "invalidContract",
      "The server facts document is for a different run than the one requested.",
    );
  }
  return parsed.data;
}
