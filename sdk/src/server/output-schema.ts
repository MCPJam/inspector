/**
 * Whether a tool result carries the structured output its tool declares. MCP
 * says a tool with an `outputSchema` must return `structuredContent` that fits
 * it, and a client refuses the result otherwise; an error result is exempt.
 *
 * The JSON Schema validator is passed in. Node servers can use Ajv, which
 * compiles a schema with `new Function`; Workers forbid that, so a worker
 * passes a validator that interprets the schema instead.
 */

export type OutputVerdict = { ok: true } | { ok: false; message: string };

export type ValidateOutput = (value: unknown) => {
  valid: boolean;
  errorMessage?: string;
};

/**
 * Compiles an output schema with the server's validator. Returns `undefined`
 * when the validator cannot judge the schema (a dialect it does not know), and
 * throws when the schema does not compile.
 */
export type CompileOutputSchema = (schema: object) => ValidateOutput | undefined;

/**
 * One compile of an output schema: `ready` with its check, `unchecked` when
 * nothing can be said (a dialect the validator does not know, or a root
 * `$async`, whose check answers with a promise), or `broken` when the schema
 * does not compile.
 */
export type CompiledOutputSchema =
  | { status: "ready"; validate: ValidateOutput }
  | { status: "unchecked" }
  | { status: "broken"; reason: string };

const REASON_MAX = 200;

/** The compiler's message, or a fixed reason when the thrown value cannot be read. */
function reasonOf(error: unknown): string {
  try {
    const reason = error instanceof Error ? error.message : String(error);
    return reason.trim().slice(0, REASON_MAX);
  } catch {
    return "the compiler threw a value that cannot be read";
  }
}

export function compileOutputSchema(
  outputSchema: object,
  compile: CompileOutputSchema
): CompiledOutputSchema {
  try {
    // Inside the try: an in-process caller's schema can have a getter that throws.
    if ((outputSchema as { $async?: unknown }).$async) {
      return { status: "unchecked" };
    }
    const validate = compile(outputSchema);
    return validate ? { status: "ready", validate } : { status: "unchecked" };
  } catch (error) {
    return { status: "broken", reason: reasonOf(error) };
  }
}

export const MISSING_STRUCTURED_CONTENT =
  "the tool declares an output schema, so its result must include structuredContent";

export function lacksStructuredContent(result: {
  structuredContent?: unknown;
}): boolean {
  return (
    result.structuredContent === undefined || result.structuredContent === null
  );
}

export const isSchemaObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function verdictOf(
  validate: ValidateOutput,
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
 * The verdict on one result. A schema the validator cannot read passes:
 * nothing can be said, because the schema may be another server's.
 */
export function checkStructuredOutput(
  outputSchema: unknown,
  result: { isError?: unknown; structuredContent?: unknown },
  compile: CompileOutputSchema
): OutputVerdict {
  if (result.isError === true) return { ok: true };
  if (!isSchemaObject(outputSchema)) return { ok: true };
  if (lacksStructuredContent(result)) {
    return { ok: false, message: MISSING_STRUCTURED_CONTENT };
  }
  const compiled = compileOutputSchema(outputSchema, compile);
  if (compiled.status !== "ready") return { ok: true };
  return verdictOf(compiled.validate, result.structuredContent);
}
