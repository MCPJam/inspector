import Ajv from "ajv";

const ajv = new Ajv({ strict: false });

/**
 * Checks whether a tool result's `structuredContent` is valid against the
 * declared `outputSchema`.
 *
 * Returns:
 *  - `undefined` — no outputSchema or no structuredContent (nothing to check)
 *  - `true`      — structuredContent validates against the schema
 *  - `false`     — structuredContent does NOT validate (in practice the MCP
 *                  client SDK catches this before we ever see it, so this
 *                  path is defensive only)
 */
export function validateToolOutput(
  result: any,
  outputSchema?: Record<string, unknown>,
): boolean | undefined {
  if (!outputSchema) {
    return undefined;
  }

  if (result.structuredContent) {
    try {
      const validate = ajv.compile(outputSchema);
      return validate(result.structuredContent);
    } catch {
      return false;
    }
  }

  return undefined;
}
