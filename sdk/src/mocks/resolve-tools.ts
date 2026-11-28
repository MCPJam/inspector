import type { Tool } from "@modelcontextprotocol/server";
import { canonicalDigest } from "../contract/canonical.js";
import {
  answersItself,
  realAnswerOf,
  realToolNameFor,
} from "./definition-types.js";
import type {
  JsonObject,
  MockDefinition,
  MockTool,
} from "./definition-types.js";
import type { MissingEditedTool } from "./mock-errors.js";

type Obj = Record<string, unknown>;

/** The tool's listing with the parameter edits applied (hidden, fixed, described). */
function editedSchema(
  schema: Tool["inputSchema"],
  entry: MockTool
): Tool["inputSchema"] {
  const params = Object.entries(entry.params ?? {});
  if (params.length === 0) return schema;
  const properties: Obj = { ...(schema.properties as Obj | undefined) };
  let required = Array.isArray(schema.required)
    ? [...schema.required]
    : undefined;
  for (const [name, param] of params) {
    if (param.hidden === true || "fixed" in param) {
      delete properties[name];
      required = required?.filter((r) => r !== name);
    } else if (param.description !== undefined && name in properties) {
      properties[name] = {
        ...(properties[name] as Obj),
        description: param.description,
      };
    }
  }
  return {
    ...schema,
    properties: properties as JsonObject,
    ...(required ? { required } : {}),
  } as Tool["inputSchema"];
}

/** One real tool as the definition lists it under `name`. */
export function mergeTool(
  real: Tool,
  name: string,
  entry: MockTool | undefined
): Tool {
  if (!entry) return real;
  const { title, description, outputSchema, icons, annotations, _meta } = entry;
  const stated = Object.entries({
    title,
    description,
    outputSchema,
    icons,
  }).filter(([, value]) => value !== undefined);
  const merged = { ...real, ...Object.fromEntries(stated), name } as Tool;
  merged.inputSchema = editedSchema(
    (entry.inputSchema ?? real.inputSchema) as Tool["inputSchema"],
    entry
  );
  if (annotations)
    merged.annotations = {
      ...real.annotations,
      ...annotations,
    } as Tool["annotations"];
  if (_meta) merged._meta = { ...real._meta, ..._meta };
  return merged;
}

export interface ResolvedTools {
  tools: Tool[];
  /** Entries whose real tool is not in the real listing. */
  missing: MissingEditedTool[];
}

/**
 * The listing a client sees. A real tool with no entry under its name is
 * listed as is; an entry replaces the tool under its key, and lists the real
 * tool it points at (`answer.tool`, else its own name) under that key unless
 * hidden. An entry whose real tool is gone is reported in `missing`.
 */
export function resolveMockTools(
  definition: MockDefinition,
  realTools: Tool[]
): ResolvedTools {
  const entries = definition.tools ?? {};
  const realByName = new Map(realTools.map((tool) => [tool.name, tool]));
  const missing: MissingEditedTool[] = [];
  const listEntry = (key: string, entry: MockTool): Tool | undefined => {
    const realTool = realToolNameFor(key, entry);
    // A tool that answers for itself needs no real tool: when the real server
    // lacks it, it is an added tool, listed from the entry alone.
    const real =
      realByName.get(realTool) ??
      (answersItself(entry)
        ? ({ name: key, inputSchema: { type: "object" } } as Tool)
        : undefined);
    if (!real) {
      missing.push({ tool: key, realTool });
      return undefined;
    }
    return entry.hidden === true ? undefined : mergeTool(real, key, entry);
  };
  const tools: Tool[] = [];
  for (const real of realTools) {
    const entry = entries[real.name];
    const listed = entry ? listEntry(real.name, entry) : real;
    if (listed) tools.push(listed);
  }
  for (const [key, entry] of Object.entries(entries)) {
    if (realByName.has(key)) continue;
    const listed = listEntry(key, entry);
    if (listed) tools.push(listed);
  }
  return { tools, missing };
}

/** The real call a client's call becomes, or undefined when the tool is hidden. */
export function planToolCall(
  definition: MockDefinition,
  name: string,
  args: Obj | undefined
): { realName: string; arguments: Obj } | undefined {
  const entry = definition.tools?.[name];
  if (entry?.hidden === true) return undefined;
  const sent: Obj = { ...args };
  for (const [param, edit] of Object.entries(entry?.params ?? {})) {
    if (edit.hidden === true || "fixed" in edit) delete sent[param];
    if ("fixed" in edit) sent[param] = edit.fixed;
  }
  Object.assign(sent, realAnswerOf(entry)?.arguments);
  return {
    realName: entry ? realToolNameFor(name, entry) : name,
    arguments: sent,
  };
}

/**
 * A stable SHA-256 (hex) of the real server's tool listing: the tools sorted by
 * name, each exactly as the real server listed it (every field, `_meta`
 * included), in canonical JSON (keys sorted, `undefined` dropped). The same
 * listing hashes the same whatever order its keys arrive in; any change to any
 * tool's name, description, schema, annotations or other fields changes it.
 */
export function hashRealToolListing(tools: readonly object[]): string {
  const nameOf = (tool: object) => String((tool as Tool).name);
  return canonicalDigest(
    [...tools].sort((a, b) =>
      nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0
    )
  );
}
