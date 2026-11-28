import { Ajv } from "@modelcontextprotocol/client/validators/ajv";
import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { MockDefinition } from "./definition-types.js";
import type { MockIssue } from "./validate-definition.js";

/**
 * Node only (Ajv compiles with `new Function`), like `output-schema.ts`.
 *
 * Checks each tool's input and output schema against the JSON Schema
 * meta-schema of the dialect it declares (2020-12 when it names none), so a
 * schema no client can read (`type: "bogus-type"`, `required: "id"`) is
 * refused at save instead of by a conformance run. A dialect other than
 * 2020-12 and draft-07 cannot be judged, so it passes, as it does at call time.
 */

const DRAFT_07 = new Set([
  "https://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema",
]);
const DRAFT_2020_12 = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema",
]);

type MetaValidator = { validateSchema(schema: object): boolean | Promise<unknown>; errors?: ErrorObject[] | null };

let draft2020: MetaValidator | undefined;
let draft07: MetaValidator | undefined;

function validatorFor(schema: Record<string, unknown>): MetaValidator | undefined {
  const declared = typeof schema.$schema === "string" ? schema.$schema.replace(/#$/, "") : undefined;
  if (declared === undefined || DRAFT_2020_12.has(declared)) {
    return (draft2020 ??= new Ajv2020({ strict: false, allErrors: true }));
  }
  if (DRAFT_07.has(declared)) {
    return (draft07 ??= new Ajv({ strict: false, allErrors: true }));
  }
  return undefined;
}

/** `/properties/a/type` as `properties.a.type` (JSON Pointer escapes undone). */
function dotted(pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

/** What to change, from the first (most specific) error Ajv reported at a path. */
function advice(field: string, errors: ErrorObject[]): string {
  const allowed = errors.find((error) => Array.isArray(error.params?.allowedValues));
  if (allowed) {
    return `"${field}" must be one of ${(allowed.params.allowedValues as unknown[]).join(", ")}. Change it to one of those.`;
  }
  const first = errors[0]!;
  return `"${field}" ${first.message ?? "is not valid"}. Change it to a valid JSON Schema value.`;
}

function check(where: string, label: string, schema: unknown, issues: MockIssue[]): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return;
  const meta = validatorFor(schema as Record<string, unknown>);
  if (!meta || meta.validateSchema(schema) === true) return;
  const byPath = new Map<string, ErrorObject[]>();
  for (const error of meta.errors ?? []) {
    byPath.set(error.instancePath, [...(byPath.get(error.instancePath) ?? []), error]);
  }
  for (const [pointer, errors] of byPath) {
    const path = dotted(pointer);
    const field = path.split(".").at(-1) ?? label;
    issues.push({
      code: "invalid_schema",
      path: path ? `${where}.${path}` : where,
      message: `The ${label} is not a valid JSON Schema: ${advice(field || label, errors)}`,
    });
  }
}

/** The tools whose input or output schema is not valid JSON Schema, each with the field to change. */
export function findInvalidSchemas(definition: MockDefinition): MockIssue[] {
  const issues: MockIssue[] = [];
  for (const [key, entry] of Object.entries(definition.tools ?? {})) {
    check(`tools.${key}.inputSchema`, `input schema of tool "${key}"`, entry.inputSchema, issues);
    check(`tools.${key}.outputSchema`, `output schema of tool "${key}"`, entry.outputSchema, issues);
  }
  return issues;
}
