import type { PlatformOperation } from "@mcpjam/sdk/platform";
import type { OutputFormat } from "./output.js";

/** One authoring note on a case create/update response. */
export type CaseWarning = { code: string; message: string };

/**
 * The `warnings` a case create/update response carries — authoring notes
 * that blocked nothing (the case WAS saved), such as
 * `case_passes_with_empty_answer`: every gating check passes when the agent
 * does nothing. Anything malformed is skipped rather than guessed at.
 */
export function caseWarningsOf(result: unknown): CaseWarning[] {
  const warnings = (result as { warnings?: unknown } | null | undefined)
    ?.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter(
    (warning): warning is CaseWarning =>
      !!warning &&
      typeof (warning as CaseWarning).code === "string" &&
      typeof (warning as CaseWarning).message === "string",
  );
}

/** One stderr line per warning, for human output. */
export function formatCaseWarnings(result: unknown): string[] {
  return caseWarningsOf(result).map(
    (warning) => `warning: ${warning.message} (${warning.code})`,
  );
}

/**
 * Wrap a case create/update operation so human output also prints the
 * response's warnings to stderr. JSON output already carries `warnings` in
 * the result itself, so stdout stays exactly the response there.
 */
export function withCaseWarningsOnStderr<TInput, TOutput>(
  op: PlatformOperation<TInput, TOutput>,
  format: OutputFormat,
  stderr: { write: (chunk: string) => unknown } = process.stderr,
): PlatformOperation<TInput, TOutput> {
  if (format !== "human") return op;
  return {
    ...op,
    async execute(input, context) {
      const result = await op.execute(input, context);
      for (const line of formatCaseWarnings(result)) {
        stderr.write(`${line}\n`);
      }
      return result;
    },
  };
}
