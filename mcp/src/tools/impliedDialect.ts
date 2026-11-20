/**
 * Leaves `$schema` out of a tool's advertised input schema when it only names
 * the dialect MCP already implies.
 *
 * The SDK converts every input schema with Zod's JSON Schema target
 * `draft-2020-12`, which stamps `"$schema": "https://json-schema.org/draft/2020-12/schema"`
 * on all of them. Clients pass input schemas to the model as they are, so the
 * stamp costs about 60 characters on every tool of every model call: about
 * 3% of this server's catalog.
 *
 * Which revisions this is right for:
 * - 2025-11-25 and 2026-07-28: a schema without `$schema` is JSON Schema
 *   2020-12, and clients MUST support it ("JSON Schema Usage" in
 *   `basic/index.mdx`). Dropping the stamp changes nothing.
 * - 2025-03-26 and 2025-06-18 name no default dialect, so a client validates
 *   with its own default, usually draft-07. The stamp comes off only when the
 *   schema reads the same under draft-07 and 2020-12. A schema that uses a
 *   keyword whose meaning differs between them keeps it.
 */
export const DEFAULT_MCP_DIALECT =
  "https://json-schema.org/draft/2020-12/schema";

/**
 * Keywords that mean something different, or nothing, in draft-07 than in
 * 2020-12. `$ref` is here because draft-07 ignores the keywords beside it.
 */
const DIALECT_SENSITIVE_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
  "prefixItems",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedItems",
  "unevaluatedProperties",
  "minContains",
  "maxContains",
  "contentSchema",
]);

/**
 * Whether any keyword in `node` reads differently under draft-07. Property
 * names are walked like keywords, so a property named `prefixItems` keeps the
 * stamp too: a false positive only costs the characters.
 */
function usesDialectSensitiveKeyword(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(usesDialectSensitiveKeyword);
  if (node === null || typeof node !== "object") return false;
  for (const [key, value] of Object.entries(node)) {
    if (DIALECT_SENSITIVE_KEYWORDS.has(key)) return true;
    // Draft-07's tuple form; 2020-12 spells it `prefixItems`.
    if (key === "items" && Array.isArray(value)) return true;
    if (usesDialectSensitiveKeyword(value)) return true;
  }
  return false;
}

/** `json` without its `$schema`, when that only restates the default dialect. */
export function omitImpliedDialect<T extends Record<string, unknown>>(
  json: T
): T {
  if (json.$schema !== DEFAULT_MCP_DIALECT) return json;
  const { $schema: _implied, ...rest } = json;
  return usesDialectSensitiveKeyword(rest) ? json : (rest as T);
}
