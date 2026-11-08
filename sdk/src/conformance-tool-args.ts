/**
 * Tells a caller's bad arguments apart from a failing server.
 *
 * Several checks call a tool the caller picked, with arguments the caller
 * supplied. When that call fails, the server is only to blame if the
 * arguments were valid by the tool's own declared `inputSchema`. Arguments the
 * schema rejects are the caller's setup gap (gray "Not run", no point lost).
 *
 * `unknown` means we cannot tell — no schema, a dialect the validator does not
 * speak (it would let everything through), or a schema that does not compile —
 * and callers then keep the server-side verdict they had before.
 *
 * Node only: the validator compiles schemas with `new Function`. Keep this out
 * of the browser entry.
 */

import { DialectAwareJsonSchemaValidator } from "./mcp-client-manager/dialect-aware-json-schema-validator.js";

export type ToolArgsVerdict =
  | { verdict: "valid" }
  | { verdict: "invalid"; message: string }
  | { verdict: "unknown" };

export function checkToolArgs(
  inputSchema: unknown,
  args: unknown,
): ToolArgsVerdict {
  if (
    !inputSchema ||
    typeof inputSchema !== "object" ||
    Array.isArray(inputSchema)
  ) {
    return { verdict: "unknown" };
  }
  let unknownDialect = false;
  try {
    const validator = new DialectAwareJsonSchemaValidator({
      onUnknownDialect: () => {
        unknownDialect = true;
      },
    });
    const validate = validator.getValidator(
      inputSchema as Parameters<typeof validator.getValidator>[0],
    );
    if (unknownDialect) return { verdict: "unknown" };
    const result = validate(args ?? {});
    if (result.valid) return { verdict: "valid" };
    return {
      verdict: "invalid",
      message: result.errorMessage?.trim() || "they don't match its input schema",
    };
  } catch {
    return { verdict: "unknown" };
  }
}

/** The plain fix shown when a picked tool got arguments its schema rejects. */
export function badToolArgsMessage(toolName: string, reason: string): string {
  return `Your arguments for "${toolName}" don't match its input schema (${reason}), so this check could not run. Fix the arguments in setup, then run again.`;
}
