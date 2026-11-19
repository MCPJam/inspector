/**
 * Creating a variant: pin the base's live `tools/list` surface, then validate
 * the edits against it and compute every hash the backend stores.
 */

import { VariantError, variantErrorMessages as copy } from "./errors.js";
import {
  canonicalJson,
  computeContentHash,
  computeEditsHash,
  computeSurfaceHash,
  computeToolHash,
} from "./hashes.js";
import type {
  VariantDraft,
  VariantEdit,
  VariantEditInput,
  VariantTool,
} from "./types.js";

export const VARIANT_LIMITS = {
  maxEdits: 200,
  /** Of edits, as canonical JSON in UTF-8. */
  maxEditsBytes: 256 * 1024,
  /** Of each new description, after trimming. */
  maxValueChars: 10_000,
  /** Of `tools/list`, when pinning the base. */
  maxSurfacePages: 100,
} as const;

/** One `tools/list` result page, with each Tool exactly as the base sent it. */
export type VariantToolsPage = {
  tools: readonly VariantTool[];
  nextCursor?: string;
};

/**
 * Reads every `tools/list` page in order, from no cursor to the page with no
 * `nextCursor`, and hashes the whole surface. A server that still has a next
 * page after `maxSurfacePages` is refused.
 */
export async function pinVariantSurface(options: {
  listPage: (cursor?: string) => Promise<VariantToolsPage>;
}): Promise<{ tools: VariantTool[]; baseSurfaceHash: string }> {
  const tools: VariantTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < VARIANT_LIMITS.maxSurfacePages; page += 1) {
    const result = await options.listPage(cursor);
    for (const tool of result.tools) tools.push(tool);
    if (result.nextCursor === undefined) {
      return { tools, baseSurfaceHash: await computeSurfaceHash(tools) };
    }
    cursor = result.nextCursor;
  }
  throw new Error(
    `The base server lists its tools across more than ${VARIANT_LIMITS.maxSurfacePages} pages, so a variant can't pin them. Make variants of servers whose tool list ends within ${VARIANT_LIMITS.maxSurfacePages} pages.`
  );
}

/**
 * Validates `edits` against the pinned tools and returns the draft the
 * backend stores: clean edits in the order given, the hashes, and a diff.
 * Throws a `VariantError` carrying the contract's code for a refused edit.
 */
export async function buildVariantDraft(input: {
  baseServerId: string;
  tools: readonly VariantTool[];
  edits: readonly VariantEditInput[];
  /** Names the base in error messages. */
  serverName?: string;
}): Promise<VariantDraft> {
  const edited = validateEdits(
    input.edits,
    input.tools,
    input.serverName ?? "The base server"
  );
  const edits = edited.map(({ edit }) => edit);
  const [editsHash, baseSurfaceHash, toolHashes] = await Promise.all([
    computeEditsHash(edits),
    computeSurfaceHash(input.tools),
    Promise.all(
      edited.map(async ({ edit, tool }) => ({
        tool: edit.target,
        hash: await computeToolHash(tool),
      }))
    ),
  ]);
  return {
    edits,
    editsHash,
    baseSurfaceHash,
    toolHashes,
    contentHash: await computeContentHash({
      baseServerId: input.baseServerId,
      baseSurfaceHash,
      editsHash,
    }),
    diff: edited.map(({ edit, tool }) => ({
      tool: edit.target,
      field: "description",
      before: typeof tool.description === "string" ? tool.description : null,
      after: edit.value,
    })),
  };
}

/** Each edit, narrowed, with the pinned tool it changes. */
function validateEdits(
  edits: readonly VariantEditInput[],
  tools: readonly VariantTool[],
  serverName: string
): { edit: VariantEdit; tool: VariantTool }[] {
  if (edits.length === 0) {
    throw new TypeError("A variant needs at least one edit.");
  }
  if (edits.length > VARIANT_LIMITS.maxEdits) {
    throw new VariantError("VARIANT_TOO_LARGE", copy.VARIANT_TOO_LARGE());
  }
  const byName = new Map<string, VariantTool>();
  for (const tool of tools)
    if (!byName.has(tool.name)) byName.set(tool.name, tool);
  const targets = new Set<string>();
  const edited = edits.map(({ feature, target, op, value }) => {
    if (feature !== "tools.description") {
      throw new VariantError(
        "VARIANT_FEATURE_NOT_VARIABLE",
        copy.VARIANT_FEATURE_NOT_VARIABLE(feature)
      );
    }
    const chars = typeof value === "string" ? value.trim().length : 0;
    if (
      op !== "set" ||
      typeof value !== "string" ||
      chars < 1 ||
      chars > VARIANT_LIMITS.maxValueChars
    ) {
      throw new VariantError(
        "VARIANT_INVALID_VALUE",
        copy.VARIANT_INVALID_VALUE(target)
      );
    }
    if (targets.has(target)) {
      throw new VariantError(
        "VARIANT_DUPLICATE_EDIT",
        copy.VARIANT_DUPLICATE_EDIT(target)
      );
    }
    targets.add(target);
    const tool = byName.get(target);
    if (!tool) {
      throw new VariantError(
        "VARIANT_UNKNOWN_TARGET",
        copy.VARIANT_UNKNOWN_TARGET(serverName, target)
      );
    }
    const edit: VariantEdit = { feature, target, op, value };
    return { edit, tool };
  });
  const bytes = new TextEncoder().encode(
    canonicalJson(edited.map(({ edit }) => edit))
  ).byteLength;
  if (bytes > VARIANT_LIMITS.maxEditsBytes) {
    throw new VariantError("VARIANT_TOO_LARGE", copy.VARIANT_TOO_LARGE());
  }
  return edited;
}
