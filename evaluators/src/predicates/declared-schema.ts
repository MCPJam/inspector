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
  | { kind: "error"; reason: string }
  | { kind: "not_applicable"; reason: string };

/**
 * Checks each result against the output schema its tool declared.
 *
 * MCP requires a tool with an `outputSchema` to return `structuredContent`
 * that conforms to it, so only `structuredContent` is read; text that happens
 * to parse as JSON is not a structured result. A result stored without its
 * raw CallToolResult is reported as unmeasured, not as a failure. Error
 * results are skipped,
 * because the spec does not hold them to the schema. Tools that declare no
 * output schema have nothing to conform to and are skipped too.
 */
export function checkDeclaredSchemas(
  results: readonly TranscriptToolResult[],
  declarations: readonly TranscriptToolDeclaration[],
): DeclaredSchemaVerdict {
  // A result records the tool name, not the server that answered it. When
  // two servers declare the same name with different output schemas, the
  // schema the result must meet is unknown, so it is not guessed.
  const schemaFor = new Map<string, unknown>();
  const ambiguous = new Set<string>();
  const seen = new Map<string, string>();
  for (const tool of declarations) {
    const shape = JSON.stringify(tool.outputSchema ?? null);
    const earlier = seen.get(tool.name);
    if (earlier !== undefined && earlier !== shape) ambiguous.add(tool.name);
    seen.set(tool.name, shape);
    if (tool.outputSchema !== undefined && !schemaFor.has(tool.name)) {
      schemaFor.set(tool.name, tool.outputSchema);
    }
  }
  if (schemaFor.size === 0) {
    return {
      kind: "not_applicable",
      reason: "no tool declares an output schema",
    };
  }
  const failures: string[] = [];
  const unresolved = new Set<string>();
  let uncaptured = 0;
  let checked = 0;
  for (const result of results) {
    if (result.isError === true) continue;
    if (ambiguous.has(result.toolName)) {
      unresolved.add(result.toolName);
      continue;
    }
    const schema = schemaFor.get(result.toolName);
    if (schema === undefined) continue;
    if (result.structuredContent === undefined) {
      // Only a stored raw CallToolResult can show the field was absent. A
      // result kept as model-visible output alone was not measured.
      if (result.rawBytes === undefined) {
        uncaptured += 1;
        continue;
      }
      checked += 1;
      failures.push(
        `"${result.toolName}" declares an output schema but returned no structuredContent`,
      );
      continue;
    }
    checked += 1;
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
  if (unresolved.size > 0) {
    return {
      kind: "error",
      reason: `${[...unresolved].map((n) => `"${n}"`).join(", ")} is declared by more than one server with different output schemas, and the result does not record which server answered`,
    };
  }
  if (uncaptured > 0) {
    return {
      kind: "error",
      reason: `${uncaptured} result(s) were stored without the raw CallToolResult, so their structuredContent could not be checked`,
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
