/**
 * The shape gate for a caller-supplied id on its way to a Convex `v.id(...)`
 * validator.
 *
 * Convex rejects an argument that does not parse as a document id BEFORE the
 * handler runs, and in production it reports that rejection as the same
 * redacted `"[Request ID: …] Server Error"` a genuine crash produces. So by
 * the time the rejection reaches a route there is nothing left to classify:
 * `convex-read-errors.ts` reads the redaction as an outage and answers 502,
 * which pages. The only place the difference is still visible is BEFORE the
 * call, where the id is still a string we can look at.
 *
 * Hence a gate rather than a better translator. The invariant — "this path
 * segment names one document" — belongs to the HTTP boundary that accepted it,
 * and checking it there makes the failure impossible rather than caught late.
 *
 * Opt-in per parameter, deliberately NOT router middleware:
 * `registry.ts`'s `/registry/directory-servers/:idOrName` accepts a NAME in an
 * id-shaped slot, and a blanket gate would break it. A route asks for this
 * when its parameter really is an id.
 */
import type { Context } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { logger } from "../../utils/logger.js";
import { redactForLog } from "./redact-log-message.js";

/**
 * Convex document ids are lowercase unhyphenated base32-ish tokens of ~32
 * characters. The window is wider than every id observed in production
 * (uniformly 32) because Convex does not publish the format as stable, and an
 * over-tight gate turns a backend id-format change into a uniform 404 for
 * every caller. Do not narrow it to `{32}` — the `logger.warn` below is how
 * such a change is meant to surface instead.
 *
 * WHAT THIS DOES AND DOES NOT CATCH, because the width has a cost. The window
 * exists for deploy resilience, not for accuracy: it catches the failure that
 * motivated it — a caller sending MORE THAN ONE id in one slot, which is
 * always far outside it — and it deliberately does not catch a near-miss, a
 * 31-character truncation or a 33-character value with a stray byte. Those
 * still reach Convex and still fail the way this module exists to prevent, so
 * a caller with an off-by-one id shape is not covered here and must be found
 * from the Axiom counter instead.
 *
 * `cli/src/commands/registry.ts` holds a deliberately DIFFERENT copy pinned to
 * `{32}`. That one only decides which query parameter to serialize a value
 * into and never rejects, so a tight shape is free there; here a false
 * negative is a 404. Neither should be "corrected" into the other — see that
 * file's header.
 */
export function looksLikeConvexId(value: string): boolean {
  return /^[a-z0-9]{30,36}$/.test(value);
}

export interface ConvexIdParamOptions {
  /** Axiom scope for the rejection counter — "v1.evals", "v1.hosts". */
  scope: string;
  /**
   * The 404 copy. Deliberately the same sentence a genuinely missing resource
   * gets: a distinguishable 400 would confirm to an unauthorized caller that a
   * well-formed id names something real and a malformed one does not.
   */
  notFoundMessage: string;
}

/**
 * Assert `value` is id-shaped, or throw the 404.
 *
 * `logger.warn`, neither silence nor `logger.error`. Warn does not capture, so
 * a client retrying a bad id costs no Sentry events — which is the whole point
 * of the change. But the rejection is still counted in Axiom under `scope`,
 * because the gate has a second and much less benign failure mode: if Convex
 * ever changes its id format, this function starts answering 404 to EVERYONE,
 * under a status no 5xx monitor watches. The counter is what makes that visible
 * and rate-alertable. Same reasoning as the deploy-skew warn in
 * `convex-read-errors.ts`.
 *
 * The value is logged by LENGTH plus a truncated prefix, never whole: it is
 * unvalidated caller input, and the incident that motivated this arrived as a
 * 165-character path segment. The length alone identifies the multi-id case.
 *
 * REDACTED before truncated, and in that order. The value is whatever a client
 * put in an id slot, which includes what a mis-built URL puts there — a bearer
 * token, an `sk_`/`slk_` key, a signed share secret — and this line is designed
 * to fire on high-volume retry loops, so a leak here accumulates. Truncation is
 * not redaction: slicing first can cut a credential in half and leave the
 * remaining fragment unrecognizable to `CREDENTIAL_PATTERN`, which is exactly
 * how a scrubber silently stops scrubbing. Same redactor the read and write
 * translators use, for the same reason they share it.
 */
export function requireConvexIdShape(
  value: string | undefined,
  param: string,
  options: ConvexIdParamOptions
): string {
  if (value !== undefined && looksLikeConvexId(value)) return value;
  const sample = redactForLog(value ?? "").slice(0, 64);
  // `detail`, NOT `message`: `ingestToAxiom` spreads the context and THEN sets
  // `message` from its first argument, so a `message` key here is silently
  // overwritten and the diagnosis — the point of the line — never lands.
  logger.warn(`[${options.scope}] rejected a malformed id parameter`, {
    scope: options.scope,
    param,
    detail: `not a Convex id (length ${value?.length ?? 0}): ${sample}`,
  });
  throw new WebRouteError(404, ErrorCode.NOT_FOUND, options.notFoundMessage);
}

/** {@link requireConvexIdShape} on a path parameter. */
export function requireConvexIdParam(
  c: Context,
  param: string,
  options: ConvexIdParamOptions
): string {
  return requireConvexIdShape(c.req.param(param), param, options);
}
