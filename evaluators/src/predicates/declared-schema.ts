import { canonicalJson } from "../contract/canonical.js";
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
  | { kind: "empty_scope"; reason: string }
  | { kind: "not_applicable"; reason: string };

/**
 * Checks each result against the output schema its tool declared.
 *
 * MCP requires a tool with an `outputSchema` to return `structuredContent`
 * that conforms to it, so only `structuredContent` is read; text that happens
 * to parse as JSON is not a structured result. A result stored without its
 * raw CallToolResult is unmeasured unless the client rejected the output for
 * failing its schema. The spec exempts results with isError and tools without
 * a declared output schema.
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
    // Key order is not meaning: two servers with the same schema written
    // in a different order are not ambiguous.
    const shape = canonicalJson(tool.outputSchema ?? null);
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
  const unvalidated = new Set<string>();
  let uncaptured = 0;
  let checked = 0;
  for (const result of results) {
    if (result.isError === true) continue;
    if (
      schemaFor.has(result.toolName) &&
      (result.callFailure === "output_schema_mismatch" ||
        result.callFailure === "missing_structured_content")
    ) {
      checked += 1;
      failures.push(
        result.callFailure === "missing_structured_content"
          ? `"${result.toolName}" declares an output schema but returned no structuredContent`
          : `"${result.toolName}" returned structuredContent that the client rejected against its declared output schema`,
      );
      continue;
    }
    if (ambiguous.has(result.toolName)) {
      unresolved.add(result.toolName);
      continue;
    }
    const schema = schemaFor.get(result.toolName);
    if (schema === undefined) continue;
    if (result.callFailure === "protocol") {
      unvalidated.add(
        `"${result.toolName}" did not return a result the client could validate`,
      );
      continue;
    }
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
    const validation = validateAgainstSchema(schema, result.structuredContent);
    if (validation.outcome === "unsupported-dialect") {
      unvalidated.add(
        `"${result.toolName}" declares an unsupported output schema dialect "${validation.dialect}"`,
      );
      continue;
    }
    if (validation.outcome === "unusable-schema") {
      unvalidated.add(
        `"${result.toolName}" declares an unusable output schema: ${validation.message}`,
      );
      continue;
    }
    checked += 1;
    if (validation.outcome === "valid") continue;
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
  if (unvalidated.size > 0) {
    return { kind: "error", reason: [...unvalidated].slice(0, 3).join("; ") };
  }
  return checked === 0
    ? {
        kind: "empty_scope",
        reason: "no successful result in scope came from a tool that declares an output schema",
      }
    : {
        kind: "pass",
        reason: `${checked} result(s) match their tool's declared output schema`,
      };
}
