import { DialectAwareJsonSchemaValidator } from "../mcp-client-manager/dialect-aware-json-schema-validator.js";
import type { MockDefinition } from "./definition-types.js";
import type { MockIssue } from "./validate-definition.js";

/**
 * Node only: the validator compiles schemas with `new Function`, so this
 * module stays out of `definition.ts` (the browser-safe entry).
 */

export type OutputVerdict = { ok: true } | { ok: false; message: string };

type Validate = (value: unknown) => { valid: boolean; errorMessage?: string };

/**
 * One compile of an output schema: `ready` with its validator, `unchecked`
 * when nothing can be said (a dialect this validator does not know, or a root
 * `$async`, which Ajv answers with a Promise the adapter would read as valid),
 * or `broken` when the compiler threw.
 */
type CompiledOutputSchema =
  | { status: "ready"; validate: Validate }
  | { status: "unchecked" }
  | { status: "broken"; reason: string };

const REASON_MAX = 200;

function compileOutputSchema(outputSchema: object): CompiledOutputSchema {
  let unknownDialect = false;
  try {
    // Inside the try: an in-process caller's schema can have a getter that throws.
    if ((outputSchema as { $async?: unknown }).$async) {
      return { status: "unchecked" };
    }
    const validator = new DialectAwareJsonSchemaValidator({
      onUnknownDialect: () => {
        unknownDialect = true;
      },
    });
    const validate = validator.getValidator(
      outputSchema as Parameters<typeof validator.getValidator>[0]
    );
    return unknownDialect
      ? { status: "unchecked" }
      : { status: "ready", validate };
  } catch (error) {
    return { status: "broken", reason: reasonOf(error) };
  }
}

/** The compiler's message, or a fixed reason when the thrown value cannot be read. */
function reasonOf(error: unknown): string {
  try {
    const reason = error instanceof Error ? error.message : String(error);
    return reason.trim().slice(0, REASON_MAX);
  } catch {
    return "the compiler threw a value that cannot be read";
  }
}

const isSchemaObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function missingStructuredContent(result: {
  structuredContent?: unknown;
}): boolean {
  return (
    result.structuredContent === undefined || result.structuredContent === null
  );
}

const MISSING_MESSAGE =
  "the tool declares an output schema, so its result must include structuredContent";

function verdictOf(
  validate: Validate,
  structuredContent: unknown
): OutputVerdict {
  try {
    const verdict = validate(structuredContent);
    return verdict.valid
      ? { ok: true }
      : {
          ok: false,
          message:
            verdict.errorMessage?.trim() ||
            "structuredContent does not match the output schema",
        };
  } catch {
    // A validator that throws cannot say the result is wrong.
    return { ok: true };
  }
}

/**
 * Whether a successful result carries the structured output its tool declares.
 * A tool with an `outputSchema` must return `structuredContent` that fits it
 * (MCP says so; a client rejects the result otherwise). An error result is
 * exempt. A schema this validator cannot read passes: nothing can be said,
 * because the schema may be the real server's.
 */
export function checkStructuredOutput(
  outputSchema: unknown,
  result: { isError?: unknown; structuredContent?: unknown }
): OutputVerdict {
  if (result.isError === true) return { ok: true };
  if (!isSchemaObject(outputSchema)) return { ok: true };
  if (missingStructuredContent(result)) {
    return { ok: false, message: MISSING_MESSAGE };
  }
  const compiled = compileOutputSchema(outputSchema);
  if (compiled.status !== "ready") return { ok: true };
  return verdictOf(compiled.validate, result.structuredContent);
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
    const compiled = compileOutputSchema(tool.outputSchema);
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
      const verdict = missingStructuredContent(result)
        ? { ok: false as const, message: MISSING_MESSAGE }
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
