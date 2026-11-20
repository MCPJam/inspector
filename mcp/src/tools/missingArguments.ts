/**
 * Says what a missing argument is, in the validation error a model reads.
 *
 * Zod reports a required argument the call left out as "Invalid input:
 * expected string, received undefined", which names a type but not what to
 * pass or where to get it. The parameter's own description already says
 * both ("Eval run ID, as returned by run_eval_suite or list_eval_suite_runs"),
 * so an issue whose input is absent gets that description instead.
 */
import type { StandardSchemaV1 } from "@modelcontextprotocol/server";

type JsonObject = Record<string, unknown>;
type Issue = StandardSchemaV1.Issue;
type PathSegment = NonNullable<Issue["path"]>[number];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyOf(segment: PathSegment): PropertyKey {
  return typeof segment === "object" ? segment.key : segment;
}

function valueAt(input: unknown, path: readonly PathSegment[]): unknown {
  let node = input;
  for (const segment of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<PropertyKey, unknown>)[keyOf(segment)];
  }
  return node;
}

/** The JSON Schema of the value at `path`, following properties and items. */
function schemaAt(
  schema: unknown,
  path: readonly PathSegment[]
): JsonObject | undefined {
  let node = schema;
  for (const segment of path) {
    if (!isObject(node)) return undefined;
    const key = keyOf(segment);
    node =
      typeof key === "number"
        ? node.items
        : isObject(node.properties)
          ? node.properties[String(key)]
          : undefined;
  }
  return isObject(node) ? node : undefined;
}

/** `issues` with each missing argument's message replaced by its description. */
export function explainMissingArguments(
  issues: readonly Issue[],
  input: unknown,
  inputSchema: unknown
): Issue[] {
  return issues.map((issue) => {
    const path = issue.path ?? [];
    if (path.length === 0 || valueAt(input, path) !== undefined) return issue;
    const description = schemaAt(inputSchema, path)?.description;
    return {
      ...issue,
      message:
        typeof description === "string" && description.trim()
          ? `required. ${description.trim()}`
          : "required.",
    };
  });
}
