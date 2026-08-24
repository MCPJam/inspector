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
import { translateConvexReadError } from "./convex-read-errors.js";
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
 * True when a Convex call failed because the DEPLOYMENT does not export the
 * function — the one failure this route is allowed to read as "the contract
 * is not deployed yet" rather than an outage. Matched on the message because
 * Convex surfaces this as a plain client error with no structured code.
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
      if (isMissingConvexFunctionError(error)) {
        throw new WebRouteError(
          422,
          ErrorCode.FEATURE_NOT_SUPPORTED,
          "This deployment predates the pre-run disclosure contract — upgrade the MCPJam backend to see what a run would disclose.",
          { reason: "contract_unavailable" }
        );
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
    if (
      disclosure.execution &&
      typeof disclosure.execution === "object" &&
      !Array.isArray(disclosure.execution)
    ) {
      projected.execution = withLocus(
        disclosure.execution as Record<string, unknown>
      );
    }

    return v1Resource(c, projected);
  }
);

export default evalDisclosure;
