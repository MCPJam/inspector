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
  | { kind: "empty_scope"; reason: string };

/**
 * Checks each result against the output schema its tool declared.
 *
 * Only raw structured content or a confirmed client schema rejection can
 * prove a violation. Tool errors and tools without a schema are exempt.
 */
export function checkDeclaredSchemas(
  results: readonly TranscriptToolResult[],
  declarations: readonly TranscriptToolDeclaration[],
): DeclaredSchemaVerdict {
  const byName = new Map<string, TranscriptToolDeclaration[]>();
  for (const tool of declarations) {
    const sameName = byName.get(tool.name) ?? [];
    sameName.push(tool);
    byName.set(tool.name, sameName);
  }
  const failures: string[] = [];
  const unvalidated = new Set<string>();
  let checked = 0;
  for (const result of results) {
    if (result.isError === true) continue;
    const name = result.declaredToolName ?? result.toolName;
    if (
      result.callFailure === "output_schema_mismatch" ||
      result.callFailure === "missing_structured_content"
    ) {
      checked += 1;
      failures.push(
        result.callFailure === "missing_structured_content"
          ? `"${name}" declares an output schema but returned no structuredContent`
          : `"${name}" returned structuredContent that the client rejected against its declared output schema`,
      );
      continue;
    }
    const candidates = (byName.get(name) ?? []).filter(
      (tool) => !result.declaredServerKey || result.declaredServerKey === tool.serverKey,
    );
    if (candidates.length === 0) {
      unvalidated.add(`"${name}" could not be matched to a captured tool declaration`);
      continue;
    }
    const schema = candidates[0]?.outputSchema;
    try {
      if (candidates.some(({ outputSchema }) =>
        outputSchema !== schema &&
        (outputSchema === undefined || schema === undefined ||
          canonicalJson(outputSchema) !== canonicalJson(schema)),
      )) {
        unvalidated.add(
          `"${name}" is declared by more than one server with different output schemas, and the result does not record which server answered`,
        );
        continue;
      }
    } catch {
      unvalidated.add(`"${name}" has an unreadable output schema declaration`);
      continue;
    }
    if (schema === undefined) continue;
    if (result.callFailure === "protocol") {
      unvalidated.add(
        `"${name}" did not return a result the client could validate`,
      );
      continue;
    }
    if (result.structuredContent === undefined) {
      // Only a stored raw CallToolResult can show the field was absent. A
      // result kept as model-visible output alone was not measured.
      if (result.rawBytes === undefined) {
        unvalidated.add(`"${name}" was stored without the raw CallToolResult`);
        continue;
      }
      checked += 1;
      failures.push(
        `"${name}" declares an output schema but returned no structuredContent`,
      );
      continue;
    }
    const validation = validateAgainstSchema(schema, result.structuredContent);
    if (validation.outcome === "unsupported-dialect") {
      unvalidated.add(
        `"${name}" declares an unsupported output schema dialect "${validation.dialect}"`,
      );
      continue;
    }
    if (validation.outcome === "unusable-schema") {
      unvalidated.add(
        `"${name}" declares an unusable output schema: ${validation.message}`,
      );
      continue;
    }
    checked += 1;
    if (validation.outcome === "valid") continue;
    const first = validation.violations[0];
    failures.push(
      `"${name}"${first?.at ? ` at ${first.at}` : ""}: ${
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
  if (unvalidated.size > 0) {
    return { kind: "error", reason: [...unvalidated].slice(0, 3).join("; ") };
  }
  if (!declarations.some((tool) => tool.outputSchema !== undefined)) {
    return {
      kind: "empty_scope",
      reason: "no tool declares an output schema",
    };
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
