/**
 * D7 — capture the tool catalog a selection failure was decided against.
 *
 * Neither `StageEvidence` nor `StagePromptSummaryLike` carries tool
 * descriptions or schemas — `deriveSelection` only ever sees tool call
 * NAMES. "The ask, the tool catalog, and the wrong/missing selection" are
 * not co-located anywhere else in the pipeline, so this module builds that
 * co-location once, at first-pass finalize time, from the live tool
 * registry the runner already has in scope.
 *
 * CAPTURE ONCE, NEVER RE-FETCH. The D7 judge action is a Convex backend
 * action with no MCP connection at all — only the inspector runner has the
 * live tool set (descriptions + input schemas) in scope, and only at run
 * time. The judge must reason about the catalog the model actually SAW when
 * it chose wrong, not the server's catalog as of grading time — a live
 * re-fetch after the run could describe a server that has since been
 * patched, which would judge a different catalog than the one that caused
 * the failure.
 *
 * Bounded on purpose: this is untrusted, server-authored content (see the
 * D7 plan §6) fed to an LLM judge later, so the capture itself stays small
 * regardless of how large or numerous the live tool set is.
 */

export type SelectionToolCatalogEntry = {
  name: string;
  role: "expected" | "actual";
  /** Truncated to `MAX_TOOL_CATALOG_FIELD_CHARS`. */
  description?: string;
  /** Truncated JSON, `MAX_TOOL_CATALOG_FIELD_CHARS`. */
  inputSchemaSummary?: string;
};

/** Total catalog entries kept per iteration (across both roles, deduped by name+role). */
export const MAX_SELECTION_TOOL_CATALOG_ENTRIES = 6;
/** Cap on each of `description` / `inputSchemaSummary`, independently. */
export const MAX_TOOL_CATALOG_FIELD_CHARS = 800;

/** The minimal shape this module needs from one live `ToolSet` entry. */
export type SelectionCatalogToolLike = {
  description?: unknown;
  inputSchema?: unknown;
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Best-effort JSON summary of a Vercel AI SDK tool's `inputSchema`. The
 * runner's live `ToolSet` wraps a JSON Schema object behind the AI SDK's
 * `Schema` interface (`{ jsonSchema, validate }`) in the common
 * (`schemas: "automatic"`) path; an override-mode tool may carry a bare
 * schema-shaped object instead. Both are handled; anything else falls back
 * to a stringified best-effort so a schema the judge cannot parse never
 * throws through this capture.
 */
function summarizeInputSchema(inputSchema: unknown): string | undefined {
  if (inputSchema === undefined || inputSchema === null) return undefined;
  const candidate =
    typeof inputSchema === "object" &&
    "jsonSchema" in (inputSchema as Record<string, unknown>)
      ? (inputSchema as { jsonSchema?: unknown }).jsonSchema
      : inputSchema;
  try {
    const text = JSON.stringify(candidate);
    if (!text) return undefined;
    return truncate(text, MAX_TOOL_CATALOG_FIELD_CHARS);
  } catch {
    return undefined;
  }
}

function catalogEntry(
  name: string,
  role: SelectionToolCatalogEntry["role"],
  tool: SelectionCatalogToolLike | undefined
): SelectionToolCatalogEntry {
  const description =
    typeof tool?.description === "string" && tool.description.length > 0
      ? truncate(tool.description, MAX_TOOL_CATALOG_FIELD_CHARS)
      : undefined;
  const inputSchemaSummary = summarizeInputSchema(tool?.inputSchema);
  return {
    name,
    role,
    ...(description ? { description } : {}),
    ...(inputSchemaSummary ? { inputSchemaSummary } : {}),
  };
}

/**
 * Build the bounded catalog for one selection failure.
 *
 * `expectedToolNames` / `actualToolNames` come straight from the SAME
 * `missing` / `unexpected` arrays `deriveSelection` already used to decide
 * `missingToolCall` / `unexpectedToolCall` — this module never re-derives
 * whether selection failed, it only explains what the model was choosing
 * between when it did. Deduplicated by `(name, role)` and capped at
 * `MAX_SELECTION_TOOL_CATALOG_ENTRIES`; a tool absent from the live
 * registry (already removed, a race with a mid-run reconnect) still gets an
 * entry with just its name — an unresolvable tool is itself evidence, not a
 * reason to drop the row silently.
 */
export function buildSelectionToolCatalog(args: {
  tools: Record<string, SelectionCatalogToolLike>;
  expectedToolNames: readonly string[];
  actualToolNames: readonly string[];
}): SelectionToolCatalogEntry[] {
  const seen = new Set<string>();
  const out: SelectionToolCatalogEntry[] = [];

  const add = (name: string, role: SelectionToolCatalogEntry["role"]) => {
    if (out.length >= MAX_SELECTION_TOOL_CATALOG_ENTRIES) return;
    const key = `${role}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(catalogEntry(name, role, args.tools[name]));
  };

  // Interleaved, not expected-then-actual: a long `expected` list (a
  // multi-turn case with a distinct expected tool missing per turn) would
  // otherwise fill the cap before `actual` is ever considered, silently
  // dropping the tool the model actually (wrongly) called — the single most
  // load-bearing entry for "did the metadata mislead the model" judgment.
  const expected = [...args.expectedToolNames];
  const actual = [...args.actualToolNames];
  while (expected.length > 0 || actual.length > 0) {
    if (expected.length > 0) add(expected.shift()!, "expected");
    if (actual.length > 0) add(actual.shift()!, "actual");
  }

  return out;
}
