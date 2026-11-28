import { Validator, type SchemaDraft } from "@cfworker/json-schema";

/**
 * Host-side check of a subscription's `arguments` against the event type's
 * `inputSchema`, BEFORE the server is contacted. ChatGPT does the same: its
 * first call with `teamId` was refused naming `team_id` as required, and the
 * model retried with the right names.
 *
 * `@cfworker/json-schema` interprets schemas instead of compiling them, so it
 * runs under the browser's CSP, and its errors name the failing location.
 */

const DIALECTS: Record<string, SchemaDraft> = {
  "http://json-schema.org/draft-04/schema": "4",
  "https://json-schema.org/draft-04/schema": "4",
  "http://json-schema.org/draft-07/schema": "7",
  "https://json-schema.org/draft-07/schema": "7",
  "http://json-schema.org/draft/2019-09/schema": "2019-09",
  "https://json-schema.org/draft/2019-09/schema": "2019-09",
  "http://json-schema.org/draft/2020-12/schema": "2020-12",
  "https://json-schema.org/draft/2020-12/schema": "2020-12",
};

/** Keywords that only say "a child failed"; the child's own error says why. */
const AGGREGATE_KEYWORDS = new Set([
  "properties",
  "items",
  "prefixItems",
  "additionalItems",
  "patternProperties",
  "allOf",
  "$ref",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

const MAX_ISSUES = 8;

export type EventArgumentsCheck =
  | { valid: true }
  /** The schema could not be checked here; the server decides. */
  | { valid: "unchecked" }
  | { valid: false; issues: string[]; hint?: string };

function locate(instanceLocation: string): string {
  const path = instanceLocation.replace(/^#/, "").split("/").filter(Boolean);
  return ["arguments", ...path].join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkEventArguments(
  inputSchema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): EventArgumentsCheck {
  // An event type with no schema takes an object of any shape.
  const schema = inputSchema ?? { type: "object" };
  const dialect =
    typeof schema.$schema === "string"
      ? schema.$schema.replace(/#$/, "")
      : undefined;
  // MCP's default dialect is 2020-12.
  const draft =
    dialect === undefined
      ? "2020-12"
      : Object.hasOwn(DIALECTS, dialect)
        ? DIALECTS[dialect]
        : undefined;
  if (!draft) return { valid: "unchecked" };
  let result: ReturnType<Validator["validate"]>;
  try {
    result = new Validator(structuredClone(schema), draft, false).validate(
      args,
    );
  } catch {
    // A schema this validator cannot interpret says nothing about the
    // arguments; the server still validates them.
    return { valid: "unchecked" };
  }
  if (result.valid) return { valid: true };
  const issues = [
    ...new Set(
      result.errors
        .filter((error) => !AGGREGATE_KEYWORDS.has(error.keyword))
        .map((error) => `${locate(error.instanceLocation)}: ${error.error}`),
    ),
  ].slice(0, MAX_ISSUES);
  // Unknown names are allowed by most schemas, so they are not an error on
  // their own, but beside a failure they are usually the cause (`trip_id`
  // for `tripId`).
  const known = isRecord(schema.properties)
    ? Object.keys(schema.properties)
    : [];
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  return {
    valid: false,
    issues: issues.length > 0 ? issues : ["arguments: do not match the schema"],
    ...(known.length > 0 && unknown.length > 0
      ? {
          hint: `These arguments aren't accepted: ${unknown.join(", ")}. Use one of: ${known.join(", ")}.`,
        }
      : {}),
  };
}
