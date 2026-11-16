import { validateAgainstSchema } from "./schema-validation.js";
import type {
  TranscriptToolDeclaration,
  TranscriptToolResult,
} from "./types.js";

/**
 * The `toolResultMatchesSchema` schema value that means "each tool's own
 * declared output schema" instead of one schema the author wrote.
 */
export const DECLARED_OUTPUT_SCHEMA = "declared";

export type DeclaredSchemaVerdict =
  | { kind: "pass"; reason: string }
  | { kind: "fail"; reason: string }
  | { kind: "error"; reason: string };

/**
 * Checks each result against the output schema its tool declared.
 *
 * MCP requires a tool with an `outputSchema` to return `structuredContent`
 * that conforms to it, so only `structuredContent` is read; text that happens
 * to parse as JSON is not a structured result. Error results are skipped,
 * because the spec does not hold them to the schema. Tools that declare no
 * output schema have nothing to conform to and are skipped too.
 */
export function checkDeclaredSchemas(
  results: readonly TranscriptToolResult[],
  declarations: readonly TranscriptToolDeclaration[],
): DeclaredSchemaVerdict {
  const schemaFor = new Map<string, unknown>();
  for (const tool of declarations) {
    if (tool.outputSchema !== undefined && !schemaFor.has(tool.name)) {
      schemaFor.set(tool.name, tool.outputSchema);
    }
  }
  const failures: string[] = [];
  let checked = 0;
  for (const result of results) {
    if (result.isError === true) continue;
    const schema = schemaFor.get(result.toolName);
    if (schema === undefined) continue;
    checked += 1;
    if (result.structuredContent === undefined) {
      failures.push(
        `"${result.toolName}" declares an output schema but returned no structuredContent`,
      );
      continue;
    }
    const validation = validateAgainstSchema(schema, result.structuredContent);
    if (validation.outcome === "valid") continue;
    if (validation.outcome === "unsupported-dialect") {
      return {
        kind: "error",
        reason: `"${result.toolName}" declares dialect "${validation.dialect}", which this validator does not carry; nothing was validated`,
      };
    }
    if (validation.outcome === "unusable-schema") {
      return {
        kind: "error",
        reason: `"${result.toolName}" declares an unusable output schema: ${validation.message}`,
      };
    }
    const first = validation.violations[0];
    failures.push(
      `"${result.toolName}"${first?.at ? ` at ${first.at}` : ""}: ${
        first?.message ?? "did not match its declared schema"
      }`,
    );
  }
  if (failures.length > 0) {
    return {
      kind: "fail",
      reason: `${failures.length}/${checked} result(s) did not match their declared output schema: ${failures
        .slice(0, 3)
        .join(
          "; ",
        )}${failures.length > 3 ? ` (+${failures.length - 3} more)` : ""}`,
    };
  }
  return {
    kind: "pass",
    reason:
      checked === 0
        ? "no result in scope came from a tool that declares an output schema; nothing to validate"
        : `${checked} result(s) match their tool's declared output schema`,
  };
}
