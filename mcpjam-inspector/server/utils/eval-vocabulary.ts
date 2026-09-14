/**
 * WHICH VOCABULARY an eval request speaks, as the caller declares it.
 *
 * The pinned contract (`docs/evals-vocabulary-consolidation.md`, "The wire")
 * renames the eval authoring fields — `checks` → `assertions`, the configured
 * count `repetitions` → `iterations`, the legacy floor `iterations` →
 * `legacyIterations` — and a rename on a `.strict()` body is a 400 against
 * every deployment that predates it. So the two spellings are negotiated with
 * a request header rather than a version path or a body field:
 *
 *     x-mcpjam-eval-vocabulary: 2
 *
 * Absent means 1, which is byte-for-byte today's contract: the same request
 * fields, the same refusals, the same response projection. Vocabulary 1 is
 * NOT widened to meet vocabulary 2 half way — a canonical spelling sent
 * without the header is an unknown key on a strict body, exactly as it is
 * today. That is what keeps the boundary decidable: two implementations
 * reading the contract cannot disagree about whether the same headerless
 * body is valid.
 *
 * Unlike `launch-context.ts`, a malformed value is REFUSED, not dropped. A
 * label that fails to parse costs a badge; a vocabulary that fails to parse
 * would silently reinterpret `iterations` — a floor under 1, an exact count
 * under 2 — and store a number the author never meant.
 *
 * A response that varies by vocabulary says so with `Vary`, so a cache can
 * never hand a vocabulary-1 projection to a vocabulary-2 reader.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { z } from "zod";
import { EVALUATOR_KINDS, PREDICATE_KINDS } from "@mcpjam/sdk/contract";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

export const EVAL_VOCABULARY_HEADER = "x-mcpjam-eval-vocabulary";

export type EvalVocabulary = 1 | 2;

/** The vocabulary a request speaks when it says nothing. */
export const DEFAULT_EVAL_VOCABULARY: EvalVocabulary = 1;

const CONTEXT_KEY = "evalVocabulary";

/**
 * Parse the header's raw value. Absent or blank is the default; `"1"` and
 * `"2"` (trimmed) are the two vocabularies; anything else is a 400 that names
 * both accepted values, because "unknown vocabulary" and "typo" need the same
 * fix and neither may be guessed at.
 */
export function parseEvalVocabulary(
  raw: string | null | undefined,
): EvalVocabulary {
  if (raw === undefined || raw === null) return DEFAULT_EVAL_VOCABULARY;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_EVAL_VOCABULARY;
  if (trimmed === "1") return 1;
  if (trimmed === "2") return 2;
  throw new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    `${EVAL_VOCABULARY_HEADER} must be "1" or "2" (received ${JSON.stringify(raw)}).`,
  );
}

type VocabularyVariables = { Variables: { [CONTEXT_KEY]: EvalVocabulary } };

/**
 * The vocabulary this request speaks.
 *
 * Reads what the middleware stored, and falls back to parsing the header so a
 * handler exercised through a bare context double (as the route tests do)
 * gets the same answer as one behind the router.
 */
export function readEvalVocabulary(c: Context): EvalVocabulary {
  const stored = (c as Context<VocabularyVariables>).get(CONTEXT_KEY);
  if (stored !== undefined) return stored;
  return parseEvalVocabulary(c.req.header(EVAL_VOCABULARY_HEADER));
}

/**
 * Parse once per request and refuse a bad value before any handler runs, so
 * the eval surface answers a malformed header uniformly — a 400 from the
 * first route rather than a 200 from a route that happened not to read it.
 */
export function evalVocabularyMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    (c as Context<VocabularyVariables>).set(
      CONTEXT_KEY,
      parseEvalVocabulary(c.req.header(EVAL_VOCABULARY_HEADER)),
    );
    await next();
  };
}

/**
 * Mark a response as varying by vocabulary. Appends rather than replaces so a
 * `Vary` another layer already set (compression, auth) survives.
 */
export function varyByEvalVocabulary(c: Context): void {
  c.header("Vary", EVAL_VOCABULARY_HEADER, { append: true });
}

/**
 * The legacy spellings a VOCABULARY-2 body may use for each canonical field,
 * exactly as the contract's "Capability" section pins them.
 *
 * `iterations` is absent from `legacyIterations` on purpose: under vocabulary
 * 1 that key IS the floor, but under vocabulary 2 it is the exact count. One
 * key means two things across the boundary, which is exactly why the
 * negotiated vocabulary — never the presence of a field — decides which sense
 * a body means. These tables are also what the V2 request schemas and their
 * both-spellings refusals are built from, so the capability can never
 * advertise a spelling the schema does not accept.
 */
export const CASE_FIELD_ALIASES_V2 = {
  assertions: ["checks", "predicates"],
  iterations: ["repetitions"],
  legacyIterations: ["runs"],
} as const;

/**
 * `checks` is listed beside `defaultPredicates` because it is the REST wire's
 * own vocabulary-1 spelling of the suite's default rules (`settings.checks` →
 * Convex `defaultPredicates`), and a vocabulary-2 body may still send it.
 */
export const SUITE_SETTINGS_ALIASES_V2 = {
  defaultAssertions: ["defaultPredicates", "checks"],
  iterations: ["repetitions"],
} as const;

/**
 * What this deployment understands, advertised on the project capabilities
 * read so a client reads the value rather than inferring support from the
 * presence of a field on an unrelated object.
 */
export const EVAL_VOCABULARY_CAPABILITY = {
  version: 2,
  evaluatorKinds: EVALUATOR_KINDS,
  assertionKinds: PREDICATE_KINDS,
  fields: {
    assertions: CASE_FIELD_ALIASES_V2.assertions,
    defaultAssertions: SUITE_SETTINGS_ALIASES_V2.defaultAssertions,
    iterations: CASE_FIELD_ALIASES_V2.iterations,
    legacyIterations: CASE_FIELD_ALIASES_V2.legacyIterations,
  },
} as const;

/**
 * The refusal for a body that spells one field twice — the contract's exact
 * sentence, shared by every surface that accepts two spellings so a caller
 * reads one message whichever route they hit.
 */
export function bothSpellingsMessage(
  canonical: string,
  legacy: string,
): string {
  return `Send ${canonical} or ${legacy}, not both — they are two spellings of one field.`;
}

/**
 * Add one issue per pair a body spells twice.
 *
 * Decided by PRESENCE, not truthiness: an explicit `null` is a clear the
 * storage layer must see, so it counts as "sent" here exactly as a value does.
 * Refused rather than resolved by precedence — `{ runs: 3, legacyIterations:
 * 5 }` is a caller who believes both landed, and picking one silently is the
 * same class of bug as stripping it.
 */
export function addBothSpellingsIssues(
  body: Record<string, unknown>,
  ctx: z.RefinementCtx,
  pairs: ReadonlyArray<readonly [canonical: string, legacy: string]>,
): void {
  for (const [canonical, legacy] of pairs) {
    if (body[canonical] !== undefined && body[legacy] !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [canonical],
        message: bothSpellingsMessage(canonical, legacy),
      });
    }
  }
}
