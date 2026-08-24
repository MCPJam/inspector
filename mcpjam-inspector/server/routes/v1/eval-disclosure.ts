/**
 * The pre-run disclosure for an eval suite launch plan — the inspector half
 * of Evals v2 Lane G, step G4 (see G4a, mcpjam-backend #1119).
 *
 * `testSuites:getRunDisclosure` computes the WHOLE contract (rail, models,
 * analysis touchpoints, capture, retention, region, subprocessors) — this
 * route PROJECTS that contract, it never recomputes it. Copies the idioms of
 * `./capabilities.ts`: `createConvexClient`, `getConvexBearerForRequest`,
 * `v1Resource`, `translateConvexReadError`, 404-never-403.
 *
 * Two things this route does that `capabilities.ts` does not:
 *
 *  1. COMPOSES `execution.locus`. The backend's `ExecutionDisclosure.locus`
 *     is a deliberate placeholder (`{ known: false, reason: ... }`) — eval
 *     execution runs in THIS process, so whether it is MCPJam-hosted or the
 *     caller's own machine is a fact only the inspector can answer. Every
 *     `execution` section this route returns has its `locus` overwritten with
 *     `{ known: true, hosted: HOSTED_MODE }`.
 *  2. NEVER DEFAULTS TOLERANTLY. `capabilities.ts` has `sandboxesOf`, which
 *     hands back a permissive value when the projection lacks a field — right
 *     there, because a reassuring default just means "ask again on the write
 *     path". That is exactly wrong here: this endpoint's whole point is to
 *     tell someone what happens to their data BEFORE they consent to a run,
 *     and a missing field silently becoming "safe" is the one failure mode
 *     that must not happen. A backend old enough to lack
 *     `testSuites:getRunDisclosure` gets an explicit `FEATURE_NOT_SUPPORTED`
 *     (`details.reason: "contract_unavailable"`), never a partial payload.
 *     Everything else the query returns passes through STRUCTURALLY (a
 *     shallow spread), so an unknown top-level section a newer backend adds —
 *     a new subprocessor, a new analysis field — reaches CLI/JSON/MCP
 *     consumers immediately rather than being dropped by a hand-typed
 *     projection that has not caught up yet.
 */
import { Hono } from "hono";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1Resource } from "./envelope.js";
import {
  classifyConvexReadError,
  translateConvexReadError,
} from "./convex-read-errors.js";
import { HOSTED_MODE } from "../../config.js";

const evalDisclosure = new Hono();

/**
 * `execution.locus`, reserved by the backend contract for this process to
 * fill in. Composed unconditionally onto every `execution` section: eval
 * execution runs here, so the inspector always knows the answer — there is
 * no "unknown" case to preserve on this side of the contract.
 */
function withLocus(execution: Record<string, unknown>): Record<string, unknown> {
  return {
    ...execution,
    locus: { known: true, hosted: HOSTED_MODE },
  };
}

/**
 * Recursively key-sorted JSON. Arrays keep their order — it is meaningful.
 * MIRRORS `canonicalJson` in mcpjam-backend `convex/lib/evalDisclosure.ts`
 * byte-for-byte — the digest this route returns must recompute to the exact
 * same value the backend's own algorithm would produce over the same facts,
 * or it stops being useful for correlating with an audit record.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digestBuffer = await crypto.subtle.digest("SHA-256", data);
  return toHex(digestBuffer);
}

/**
 * `withLocus` changes a fact the digest covers — `execution.locus` is not in
 * the backend's own exclusion list (`digest`/`computedAt`/each managed
 * rail's `observedAt`) — so the backend-computed `digest` on the raw query
 * result no longer represents the PROJECTED payload this route returns once
 * locus is composed onto it. Recomputed here, over the exact same facts
 * (composed locus included) with the exact same exclusions, so a consumer
 * validating the returned disclosure or correlating it with an audit record
 * gets a digest that actually matches what was returned.
 */
async function recomputeDigest(
  projected: Record<string, unknown>
): Promise<string> {
  const { digest: _digest, computedAt: _computedAt, ...facts } = projected;
  const execution = facts.execution as
    | { models?: Array<Record<string, unknown>> }
    | undefined;
  const digestable = {
    ...facts,
    ...(execution
      ? {
          execution: {
            ...execution,
            models: (execution.models ?? []).map((model) => {
              const rail = model.rail as
                | { managed?: boolean; outcomeIfRunNow?: Record<string, unknown> }
                | undefined;
              if (!rail?.managed) return model;
              return {
                ...model,
                rail: {
                  ...rail,
                  outcomeIfRunNow: {
                    destination: rail.outcomeIfRunNow?.destination,
                    volatile: rail.outcomeIfRunNow?.volatile,
                  },
                },
              };
            }),
          },
        }
      : {}),
  };
  return sha256Hex(canonicalJson(digestable));
}

/**
 * True when a Convex call failed because the DEPLOYMENT does not export the
 * function — the one failure this route is allowed to read as "the contract
 * is not deployed yet" rather than an outage. Matched on the message because
 * Convex surfaces this as a plain client error with no structured code.
 *
 * NOT resilient to production redaction on its own: production Convex
 * redacts a plain server-side `Error` — which is exactly the shape a
 * missing-function failure can arrive in — to the generic "Server Error",
 * and none of the three substrings below appear in that string. The catch
 * block below disambiguates a redacted failure with a preflight query
 * instead of guessing; see the comment there.
 */
function isMissingConvexFunctionError(error: unknown): boolean {
  const message = String(
    (error as { message?: unknown } | null)?.message ?? error ?? ""
  ).toLowerCase();
  return (
    message.includes("could not find public function") ||
    message.includes("could not find function") ||
    message.includes("function not found")
  );
}

/** `caseIds`/`environmentIds` as `?a=1,2,3` — the convention `catalog.ts` uses for `sourceTypes`. */
function csvQuery(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? values : undefined;
}

// GET /v1/projects/:projectId/eval-suites/:suiteId/run-disclosure
//
// `caseIds` / `environmentId` / `environmentIds` — the SAME destination-
// affecting subset `testSuites:getRunDisclosure` takes, and deliberately NOT
// the estimator's full arg set: `iterationOverride`/`planCount` only scale
// volume, which is not part of this contract, and Convex's strict validators
// make forwarding them a runtime error rather than a silent ignore. A caller
// keeps sending the full plan to `estimateSuiteRunCredits` and this
// destination-affecting subset here.
evalDisclosure.get(
  "/projects/:projectId/eval-suites/:suiteId/run-disclosure",
  async (c) => {
    // `:projectId` names the resource path for REST consistency with every
    // sibling route; it does not gate this read. `testSuites:getRunDisclosure`
    // authorizes per-suite (`authorizeForSuite(ctx, suiteId, userId,
    // 'run.view')`) and does not take a projectId argument — a suite id
    // already answers "which project" on the backend.
    const suiteId = c.req.param("suiteId");
    const caseIds = csvQuery(c.req.query("caseIds"));
    const environmentId = c.req.query("environmentId") || undefined;
    const environmentIds = csvQuery(c.req.query("environmentIds"));
    // Rejected HERE, not left for Convex's validator: forwarding both would
    // hit `ArgumentValidationError`, which `translateConvexReadError` reads as
    // "the resource you named cannot exist" and answers 404 — correct for a
    // bad id, misleading for a caller who sent an ambiguous but well-formed
    // request.
    if (environmentId && environmentIds) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "environmentId and environmentIds are mutually exclusive."
      );
    }

    const client = createConvexClient(await getConvexBearerForRequest(c));

    let disclosure: Record<string, unknown> | null;
    try {
      disclosure = (await client.query("testSuites:getRunDisclosure" as never, {
        suiteId,
        ...(caseIds ? { caseIds } : {}),
        ...(environmentId ? { environmentId } : {}),
        ...(environmentIds ? { environmentIds } : {}),
      } as never)) as Record<string, unknown> | null;
    } catch (error) {
      // The missing-function branch: unambiguous, no redaction risk — Convex
      // reports this the same way in every environment.
      if (isMissingConvexFunctionError(error)) {
        throw new WebRouteError(
          422,
          ErrorCode.FEATURE_NOT_SUPPORTED,
          "This deployment predates the pre-run disclosure contract — upgrade the MCPJam backend to see what a run would disclose.",
          { reason: "contract_unavailable" }
        );
      }
      // The redacted branch: production Convex turns a plain server-side
      // `Error` into the generic "Server Error" — and BOTH a missing-function
      // failure and `authorizeForSuite`'s view-tier refusal are plain `Error`
      // throws upstream, so redaction collapses them into the exact same
      // string. Guessing either reading unconditionally is wrong for the
      // other caller: reading every redacted failure as "not deployed yet"
      // turns a genuine "you cannot see this suite" refusal into a 422 that
      // leaks the suite's existence (contract_unavailable implies the suite
      // WAS found, just that the query couldn't run); reading every redacted
      // failure as a refusal turns a real not-yet-promoted backend into a 404
      // that looks like the suite was deleted.
      //
      // Disambiguated with a PREFLIGHT, not a guess: `testSuites:getTestSuite`
      // is a lightweight, already-existing query whose permission tier
      // ('suite.view') is the SAME tier `getRunDisclosure` itself requires
      // ('run.view' — both map to the backend's 'view' tier in
      // `evalPermissions.ts`), so it answers exactly the question this route
      // needs: can THIS caller see THIS suite at all? Only reached on the
      // ambiguous redacted path — every successful and unambiguous request
      // still takes a single round trip.
      if (classifyConvexReadError(error).kind === "redacted") {
        let preflight: unknown;
        try {
          preflight = await client.query("testSuites:getTestSuite" as never, {
            suiteId,
          } as never);
        } catch (preflightError) {
          // The preflight itself failed the same way — translate IT, with
          // `redactedIsRefusal: true`: this query's only realistic redacted
          // failure is the same view-tier refusal `getRunDisclosure` hit, so
          // a redacted preflight failure is read as "cannot see it" → 404,
          // restoring the 404-never-403 guarantee this route claims. A
          // genuine outage (network failure, timeout) does not match the
          // redaction shape and still falls through to the incident path.
          throw translateConvexReadError(preflightError, {
            scope: "v1.evalDisclosure",
            notFoundMessage: "Eval suite not found",
            redactedIsRefusal: true,
          });
        }
        if (!preflight) {
          throw new WebRouteError(
            404,
            ErrorCode.NOT_FOUND,
            "Eval suite not found"
          );
        }
        // The caller CAN see the suite — so `getRunDisclosure`'s redacted
        // failure was not a visibility refusal. That is ALL this preflight
        // proves. It does NOT prove the failure was a missing-function
        // one: a genuine bug in the query's own handler (a malformed suite,
        // an unrelated crash) is ALSO a plain `Error` upstream, redacted to
        // the identical "Server Error" string — and this route has no
        // independent way to tell "not deployed yet" apart from "deployed
        // and broken" once membership is ruled out. Claiming
        // `contract_unavailable` here would be a real diagnosis this route
        // cannot actually make; it would also hide a genuine incident from
        // upstream-error reporting and tell a caller to "upgrade" when the
        // deployment may already have the contract. Falls through to the
        // ordinary incident path instead — an over-eager 502 during the
        // narrow pre-promotion window costs a Sentry page; a silent 422 for
        // a real bug could hide one indefinitely.
      }
      throw translateConvexReadError(error, {
        scope: "v1.evalDisclosure",
        notFoundMessage: "Eval suite not found",
      });
    }
    if (!disclosure) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    // Never default the ABSENCE of a section tolerantly either: an
    // `execution` object still gets its locus composed, but a caller with no
    // `execution` at all (an ingested run, or an unresolved plan) is left
    // exactly as the backend reported it — `executionAbsence` says why, and
    // manufacturing an `execution` block here would be the reassuring-default
    // failure this route exists to refuse.
    const projected: Record<string, unknown> = { ...disclosure };
    let composedLocus = false;
    if (
      disclosure.execution &&
      typeof disclosure.execution === "object" &&
      !Array.isArray(disclosure.execution)
    ) {
      projected.execution = withLocus(
        disclosure.execution as Record<string, unknown>
      );
      composedLocus = true;
    }
    // Only recomputed when locus was actually composed — an ingested run or
    // an unresolved plan (no `execution` section) is returned exactly as the
    // backend reported it, so its digest already matches what is returned.
    if (composedLocus) {
      projected.digest = await recomputeDigest(projected);
    }

    return v1Resource(c, projected);
  }
);

export default evalDisclosure;
