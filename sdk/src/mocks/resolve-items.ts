import type {
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplateType as ResourceTemplate,
} from "@modelcontextprotocol/server";
import { MCP_APP_MIME_TYPE } from "./definition-types.js";
import type { MockDefinition } from "./definition-types.js";
import { fillInputs } from "./saved-answers.js";
import { matchTemplate } from "./uri-template.js";

/**
 * Prompts, resources and resource templates as a client sees them: the real
 * server's, in its order, with the definition's entries laid over them, then
 * the entries the real server lacks, in definition order. Same rules as tools:
 * an entry states only what it changes, `hidden` removes, and an entry that
 * edits something the real server no longer lists is reported in `missing`
 * (the mock then refuses to list, naming it). An entry that carries content
 * (`messages`, `text`, `blob`) is the mock's own and needs no real item.
 */

type Obj = Record<string, unknown>;

/** Fields of an entry that are the mock's words, not part of what a client lists. */
const OWN_WORDS = ["hidden", "text", "blob", "messages"];

export interface ResolvedItems<T> {
  items: T[];
  /** Keys of entries that edit something the real server does not list. */
  missing: string[];
}

function overlay(
  real: Obj | undefined,
  keyField: string,
  key: string,
  entry: Obj,
  defaults: Obj
): Obj {
  const stated = Object.fromEntries(
    Object.entries(entry).filter(([field]) => !OWN_WORDS.includes(field))
  );
  const merged: Obj = { ...defaults, ...real, ...stated, [keyField]: key };
  for (const field of ["_meta", "annotations"]) {
    if (stated[field] !== undefined) {
      merged[field] = {
        ...((real?.[field] as Obj | undefined) ?? {}),
        ...(stated[field] as Obj),
      };
    }
  }
  return merged;
}

function resolve<T extends object>(
  entries: Record<string, object> | undefined,
  realItems: T[],
  keyField: string,
  ownContent: (entry: Obj) => boolean,
  defaults: (key: string) => Obj
): ResolvedItems<T> {
  const defined = (entries ?? {}) as Record<string, Obj>;
  const keyOf = (item: T) => String((item as Obj)[keyField]);
  const realByKey = new Map(realItems.map((item) => [keyOf(item), item]));
  const items: T[] = [];
  const missing: string[] = [];
  const list = (key: string, entry: Obj) => {
    const real = realByKey.get(key);
    // An edit needs the real item; an entry with content of its own does not.
    if (!real && (entry.hidden === true || !ownContent(entry))) {
      missing.push(key);
      return;
    }
    if (entry.hidden === true) return;
    items.push(
      overlay(real as Obj | undefined, keyField, key, entry, defaults(key)) as T
    );
  };
  for (const real of realItems) {
    const key = keyOf(real);
    const entry = defined[key];
    if (!entry) items.push(real);
    else list(key, entry);
  }
  for (const [key, entry] of Object.entries(defined)) {
    if (!realByKey.has(key)) list(key, entry);
  }
  return { items, missing };
}

const hasContent = (entry: Obj) =>
  entry.text !== undefined || entry.blob !== undefined;

/** The last path segment of a URI, as a default name. */
function lastSegment(uri: string): string {
  const segments = (uri.split(/[?#]/, 1)[0] ?? uri).split("/").filter(Boolean);
  return segments[segments.length - 1] ?? uri;
}

export function resolveMockPrompts(
  definition: MockDefinition,
  real: Prompt[]
): ResolvedItems<Prompt> {
  return resolve(
    definition.prompts,
    real,
    "name",
    (entry) => entry.messages !== undefined,
    () => ({})
  );
}

export function resolveMockResources(
  definition: MockDefinition,
  real: Resource[]
): ResolvedItems<Resource> {
  return resolve(definition.resources, real, "uri", hasContent, (uri) => ({
    name: lastSegment(uri),
    ...(uri.startsWith("ui://") && { mimeType: MCP_APP_MIME_TYPE }),
  }));
}

export function resolveMockTemplates(
  definition: MockDefinition,
  real: ResourceTemplate[]
): ResolvedItems<ResourceTemplate> {
  return resolve(
    definition.resourceTemplates,
    real,
    "uriTemplate",
    hasContent,
    (template) => ({ name: template })
  );
}

export type PromptPlan =
  | { kind: "hidden" }
  | { kind: "own"; result: GetPromptResult }
  | { kind: "real" };

/** Where `prompts/get` for this name is answered, and with what when the mock answers. */
export function planPromptGet(
  definition: MockDefinition,
  name: string,
  args: Record<string, string> | undefined
): PromptPlan {
  const entry = definition.prompts?.[name];
  if (entry?.hidden === true) return { kind: "hidden" };
  if (!entry?.messages) return { kind: "real" };
  return {
    kind: "own",
    result: {
      ...(entry.description !== undefined && {
        description: entry.description,
      }),
      messages: fillInputs(
        entry.messages,
        args ?? {}
      ) as GetPromptResult["messages"],
    },
  };
}

export type ResourcePlan =
  | { kind: "hidden" }
  | { kind: "own"; result: ReadResourceResult }
  | { kind: "real" };

function contentsOf(
  uri: string,
  entry: { text?: string; blob?: string; mimeType?: string; _meta?: Obj },
  fill?: Record<string, string>
): ReadResourceResult {
  const mimeType =
    entry.mimeType ?? (uri.startsWith("ui://") ? MCP_APP_MIME_TYPE : undefined);
  // An app's `_meta` (its CSP and permissions) travels on the content a client
  // reads, so it must reach the client from here and not only from the listing.
  const common = {
    uri,
    ...(mimeType && { mimeType }),
    ...(entry._meta && { _meta: entry._meta }),
  };
  return {
    contents: [
      entry.blob !== undefined
        ? { ...common, blob: entry.blob }
        : {
            ...common,
            text: fill
              ? fillInputs(entry.text ?? "", fill)
              : (entry.text ?? ""),
          },
    ],
  };
}

const hasContentOf = (entry: object): boolean => hasContent(entry as Obj);

/** Where `resources/read` for this URI is answered: a resource entry, then a template, then the real server. */
export function planResourceRead(
  definition: MockDefinition,
  uri: string
): ResourcePlan {
  const entry = definition.resources?.[uri];
  if (entry?.hidden === true) return { kind: "hidden" };
  if (entry && hasContentOf(entry))
    return { kind: "own", result: contentsOf(uri, entry) };
  for (const [template, t] of Object.entries(
    definition.resourceTemplates ?? {}
  )) {
    if (t.hidden === true || !hasContentOf(t)) continue;
    const variables = matchTemplate(template, uri);
    if (variables)
      return { kind: "own", result: contentsOf(uri, t, variables) };
  }
  return { kind: "real" };
}

/** Whether the definition adds or replaces any content a client could list. */
export function ownsItems(definition: MockDefinition): {
  prompts: boolean;
  resources: boolean;
} {
  const own = (
    map: Record<string, object> | undefined,
    has: (e: Obj) => boolean
  ) =>
    Object.values(map ?? {}).some(
      (entry) => (entry as Obj).hidden !== true && has(entry as Obj)
    );
  return {
    prompts: own(definition.prompts, (e) => e.messages !== undefined),
    resources:
      own(definition.resources, hasContent) ||
      own(definition.resourceTemplates, hasContent),
  };
}
