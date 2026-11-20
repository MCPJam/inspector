/**
 * Leaves deprecated parameters out of a tool's advertised input schema.
 *
 * A renamed parameter keeps its old spelling as an alias, marked with JSON
 * Schema's `deprecated: true` annotation (`.meta({ deprecated: true })` on the
 * Zod field), and validation still accepts it, so a caller written against
 * the old name keeps working. Listing both spellings costs every model call
 * the alias's text, and puts two optional parameters that mean the same thing
 * in front of a model that has to pick one.
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutDeprecated(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDeprecated);
  if (!isObject(node)) return node;
  const next: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    next[key] = key === "properties" ? value : withoutDeprecated(value);
  }
  if (!isObject(node.properties)) return next;
  const dropped = new Set<string>();
  const properties: JsonObject = {};
  for (const [name, schema] of Object.entries(node.properties)) {
    if (isObject(schema) && schema.deprecated === true) dropped.add(name);
    else properties[name] = withoutDeprecated(schema);
  }
  next.properties = properties;
  if (dropped.size > 0 && Array.isArray(node.required)) {
    next.required = node.required.filter(
      (name) => typeof name !== "string" || !dropped.has(name)
    );
  }
  return next;
}

/** `json` without the properties marked `deprecated: true`, at any depth. */
export function omitDeprecatedProperties<T extends JsonObject>(json: T): T {
  return withoutDeprecated(json) as T;
}
