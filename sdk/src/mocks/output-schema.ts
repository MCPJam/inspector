import { DialectAwareJsonSchemaValidator } from "../mcp-client-manager/dialect-aware-json-schema-validator.js";
import {
  MISSING_STRUCTURED_CONTENT,
  checkStructuredOutput as checkStructuredOutputWith,
  compileOutputSchema,
  isSchemaObject,
  lacksStructuredContent,
  verdictOf,
} from "../server/output-schema.js";
import type {
  CompileOutputSchema,
  OutputVerdict,
} from "../server/output-schema.js";
import type { MockDefinition } from "./definition-types.js";
import type { MockIssue } from "./validate-definition.js";

/**
 * Node only: Ajv compiles schemas with `new Function`, so this module stays
 * out of `definition.ts` (the browser-safe entry). The checks themselves are
 * in `@mcpjam/sdk/server`, with the validator passed in.
 */

export type { OutputVerdict };

/** Ajv, through the dialect-aware validator; a dialect it does not know is left unchecked. */
export const compileWithAjv: CompileOutputSchema = (schema) => {
  let unknownDialect = false;
  const validator = new DialectAwareJsonSchemaValidator({
    onUnknownDialect: () => {
      unknownDialect = true;
    },
  });
  const validate = validator.getValidator(
    schema as Parameters<typeof validator.getValidator>[0]
  );
  return unknownDialect ? undefined : validate;
};

/** {@link checkStructuredOutputWith} with Ajv. */
export function checkStructuredOutput(
  outputSchema: unknown,
  result: { isError?: unknown; structuredContent?: unknown }
): OutputVerdict {
  return checkStructuredOutputWith(outputSchema, result, compileWithAjv);
}

/** A complete token, the shape the filler fills; a lone "{{" is literal text. */
const PLACEHOLDER_TOKEN = /\{\{[^{}]+\}\}/;

/** Placeholders sit in string values; a key that looks like one is only a key. */
function hasPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return PLACEHOLDER_TOKEN.test(value);
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (typeof value === "object" && value !== null)
    return Object.values(value).some(hasPlaceholder);
  return false;
}

/**
 * Output-schema problems in a definition: a schema that does not compile (an
 * MCP client refuses to call such a tool), and saved results that break the
 * output schema their own entry declares. A result whose `structuredContent`
 * holds `{{input.x}}` is skipped here: its values are known only when a call
 * fills them, and the runtime checks the filled result then. A schema this
 * validator cannot read still needs `structuredContent` to be present. An
 * error result is exempt. A tool that keeps the real server's schema is
 * checked at call time too, since that schema is not in the definition.
 */
export function checkSavedOutputs(definition: MockDefinition): MockIssue[] {
  const issues: MockIssue[] = [];
  for (const [name, tool] of Object.entries(definition.tools ?? {})) {
    if (!isSchemaObject(tool.outputSchema)) continue;
    // One compile per tool, whatever its answer.
    const compiled = compileOutputSchema(tool.outputSchema, compileWithAjv);
    if (compiled.status === "broken") {
      const path = `tools.${name}.outputSchema`;
      issues.push({
        code: "invalid_value",
        path,
        message: `${path} does not compile: ${compiled.reason}. An MCP client refuses to call a tool whose output schema does not compile. Fix the schema, or remove it; its saved cases are not checked until then.`,
      });
      continue;
    }
    if (tool.answer?.from !== "saved") continue;
    tool.answer.cases.forEach((entry, index) => {
      const result = entry.result;
      if (!result || result.isError === true) return;
      // Only structuredContent is filled at call time; a placeholder in a text
      // block cannot supply it, so it does not excuse a missing or wrong one.
      if (hasPlaceholder(result.structuredContent)) return;
      // Presence needs no validator, so an unchecked schema still gets it.
      const verdict = lacksStructuredContent(result)
        ? { ok: false as const, message: MISSING_STRUCTURED_CONTENT }
        : compiled.status === "ready"
          ? verdictOf(compiled.validate, result.structuredContent)
          : { ok: true as const };
      if (verdict.ok) return;
      const path = `tools.${name}.answer.cases.${index}.result`;
      issues.push({
        code: "invalid_value",
        path,
        message: `${path} breaks the output schema of "${name}": ${verdict.message}. Fix the result, or change the output schema.`,
      });
    });
  }
  return issues;
}
