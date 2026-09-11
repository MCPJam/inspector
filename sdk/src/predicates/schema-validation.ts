/**
 * Structured JSON Schema validation for the predicate evaluator.
 *
 * WHY NOT THE `jsonSchemaValidator` WRAPPER. The runtime shims
 * (`csp-safe-dialect-aware-json-schema-validator.ts` and its Ajv sibling)
 * flatten every violation into ONE prose string. That is the right shape for
 * "did this tool call validate", which is all `tools/call` needs — but two of
 * the checks here have to say WHICH RULE the arguments broke: a missing
 * required property, a wrong type, a value outside an enum, and a key a closed
 * schema forbids are four different notes to a server developer, and reading
 * them back out of prose is a parser of somebody else's error text.
 *
 * So this module goes one layer down to the SAME ENGINE the CSP-safe shim uses
 * (`@cfworker/json-schema`, which INTERPRETS schemas instead of compiling them
 * with `new Function`, and is therefore safe in browsers and on workerd), and
 * keeps the shim's dialect rule verbatim:
 *
 *   - no `$schema`, or a 2020-12 URI  → the 2020-12 engine
 *   - a draft-07 URI                  → the draft-07 engine
 *   - anything else                   → not validated; NOT a violation
 *
 * That last line matters. An exotic-but-legal dialect is not a defect in the
 * server, and a check that failed on one would be reporting our own gap as
 * their bug.
 */

import { Validator, type OutputUnit } from "@cfworker/json-schema";

const DRAFT_2020_12_URIS = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema",
]);

const DRAFT_07_URIS = new Set([
  "https://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema",
]);

/**
 * Which rule the instance broke, in the vocabulary a server developer acts on.
 *
 * `hallucinated-param` is deliberately narrow: it means a key the schema
 * EXPLICITLY forbids (`additionalProperties: false`, `unevaluatedProperties:
 * false`). A key merely absent from `properties` is legal JSON Schema and is
 * not classified here at all — see `undeclaredKeys` in the caller.
 */
export type SchemaViolationClass =
  | "missing-required"
  | "wrong-type"
  | "bad-enum"
  | "hallucinated-param"
  | "other";

export type SchemaViolation = {
  class: SchemaViolationClass;
  /** JSON pointer-ish location the engine reported (`#/limit`). */
  at: string;
  message: string;
};

export type SchemaValidation =
  | { outcome: "valid" }
  | { outcome: "invalid"; violations: SchemaViolation[] }
  /** The schema declares a dialect neither engine carries. Not a violation. */
  | { outcome: "unsupported-dialect"; dialect: string }
  /** The schema itself is unusable (malformed, uncompilable). */
  | { outcome: "unusable-schema"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function classify(keyword: string): SchemaViolationClass {
  switch (keyword) {
    case "required":
      return "missing-required";
    case "type":
      return "wrong-type";
    case "enum":
    case "const":
      return "bad-enum";
    case "additionalProperties":
    case "unevaluatedProperties":
      return "hallucinated-param";
    default:
      return "other";
  }
}

/**
 * The violations worth reporting, most specific first.
 *
 * The engine emits a parent `properties` unit alongside the leaf unit that
 * actually failed ("Property \"q\" does not match schema." next to "Instance
 * type \"number\" is invalid."). The parent names no rule, so keeping it would
 * bury the classified leaf under an unclassifiable duplicate.
 */
function meaningfulViolations(errors: OutputUnit[]): SchemaViolation[] {
  const violations = errors
    .filter((unit) => unit.keyword !== "properties" && unit.keyword !== "false")
    .map((unit) => ({
      class: classify(unit.keyword),
      at: unit.instanceLocation,
      message: unit.error,
    }));
  // `additionalProperties` reports on the parent and `false` on the leaf; when
  // the filter above leaves nothing, fall back to whatever the engine said so
  // an invalid instance never reports zero violations.
  return violations.length > 0
    ? violations
    : errors.map((unit) => ({
        class: classify(unit.keyword),
        at: unit.instanceLocation,
        message: unit.error,
      }));
}

/**
 * Validate `instance` against `schema`, reporting which rules it broke.
 *
 * Never throws: an unusable schema is an OUTCOME, because the caller has to
 * distinguish "the server's data is wrong" from "the assertion is wrong", and
 * an exception here would blame the first for the second.
 */
export function validateAgainstSchema(
  schema: unknown,
  instance: unknown
): SchemaValidation {
  if (!isRecord(schema) && typeof schema !== "boolean") {
    return {
      outcome: "unusable-schema",
      message: "schema must be an object or a boolean",
    };
  }

  let draft: "2020-12" | "7";
  const declared =
    isRecord(schema) && typeof schema.$schema === "string"
      ? schema.$schema.replace(/#$/, "")
      : undefined;
  if (declared === undefined || DRAFT_2020_12_URIS.has(declared)) {
    draft = "2020-12";
  } else if (DRAFT_07_URIS.has(declared)) {
    draft = "7";
  } else {
    return { outcome: "unsupported-dialect", dialect: declared };
  }

  try {
    const result = new Validator(
      schema as never,
      draft,
      // Short-circuit off: a check that reports only the FIRST violation makes
      // an author fix one argument per run.
      false
    ).validate(instance);
    return result.valid
      ? { outcome: "valid" }
      : { outcome: "invalid", violations: meaningfulViolations(result.errors) };
  } catch (error) {
    return {
      outcome: "unusable-schema",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
