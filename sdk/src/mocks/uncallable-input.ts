import {
  answersItself,
  realAnswerOf,
  realToolNameFor,
} from "./definition-types.js";
import type { MockDefinition } from "./definition-types.js";
import type { MockIssue } from "./validate-definition.js";

/** The part of a real tool's listing this check reads. */
export interface RealToolInputShape {
  name: string;
  inputSchema?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertyNames(schema: unknown): Set<string> {
  if (!isRecord(schema) || !isRecord(schema.properties)) return new Set();
  return new Set(Object.keys(schema.properties));
}

function requiredNames(schema: unknown): string[] {
  if (!isRecord(schema) || !Array.isArray(schema.required)) return [];
  return schema.required.filter(
    (name): name is string => typeof name === "string"
  );
}

/**
 * Finds the entries whose input change would leave the real tool impossible
 * to call: a parameter the real tool requires that the client can no longer
 * send and the entry does not set itself.
 *
 * An entry maps an input when it fixes it (`params.<name>.fixed`) or lays it
 * over the call (`answer.arguments`), or when the entry has saved answers and
 * so never calls the real tool. The reverse also fails: a parameter the entry
 * lists that a real tool declared strict (`additionalProperties: false`) does
 * not have, which the real tool would refuse. Entries whose real tool is
 * missing from `realTools` are skipped here: the listing refuses those by name.
 */
export function findUncallableInputs(
  definition: MockDefinition,
  realTools: RealToolInputShape[]
): MockIssue[] {
  const issues: MockIssue[] = [];
  const realByName = new Map(realTools.map((tool) => [tool.name, tool]));

  for (const [key, entry] of Object.entries(definition.tools ?? {})) {
    if (entry.hidden === true || answersItself(entry)) continue;
    const realName = realToolNameFor(key, entry);
    const real = realByName.get(realName);
    if (!real || !isRecord(real.inputSchema)) continue;

    const path = `tools.${key}`;
    const params = Object.entries(entry.params ?? {});
    const hidden = new Set(
      params
        .filter(([, p]) => p.hidden === true || "fixed" in p)
        .map(([n]) => n)
    );
    const mapped = new Set([
      ...params.filter(([, p]) => "fixed" in p).map(([n]) => n),
      ...Object.keys(realAnswerOf(entry)?.arguments ?? {}),
    ]);
    const listed = new Set(
      [...propertyNames(entry.inputSchema ?? real.inputSchema)].filter(
        (name) => !hidden.has(name)
      )
    );

    if (real.inputSchema.additionalProperties === false && entry.inputSchema) {
      const realProps = propertyNames(real.inputSchema);
      for (const name of listed) {
        if (realProps.has(name)) continue;
        issues.push({
          code: "uncallable_input",
          path: `${path}.inputSchema.properties.${name}`,
          message: `Tool "${key}" lists "${name}", which the real tool "${realName}" does not take and refuses as an extra parameter. Remove "${name}" from the input schema, or map it with a saved answer.`,
        });
      }
    }

    for (const name of requiredNames(real.inputSchema)) {
      if (listed.has(name) || mapped.has(name)) continue;
      issues.push({
        code: "uncallable_input",
        path: entry.inputSchema
          ? `${path}.inputSchema`
          : `${path}.params.${name}`,
        message: `Tool "${key}" no longer takes "${name}", which the real tool "${realName}" requires, so every call would fail. Keep "${name}" in the input schema, or set it with params.${name}.fixed or answer.arguments.${name}.`,
      });
    }
  }
  return issues;
}
