/**
 * Serving a variant's `tools/list`, one result page at a time.
 *
 * Every edited tool on a page is hashed and compared with the hash pinned when
 * the variant was created. A listing runs from its page with no cursor to its
 * page with no `nextCursor`, and an edited tool that never appeared in it is
 * missing. A changed or missing tool turns the page into a
 * `VARIANT_BASE_DRIFTED` error; otherwise each edited description is replaced
 * and nothing else changes.
 */

import {
  VARIANT_BASE_DRIFTED_RPC_CODE,
  variantErrorMessages,
} from "./errors.js";
import { computeToolHash } from "./hashes.js";
import type { VariantDefinition } from "./types.js";

/** Listings waiting for their next page, at most. Older ones are forgotten. */
const MAX_OPEN_LISTINGS = 64;

export type VariantDriftRpcError = {
  code: typeof VARIANT_BASE_DRIFTED_RPC_CODE;
  message: string;
  data: { code: "VARIANT_BASE_DRIFTED"; tools: string[]; variantId: string };
};

export type ToolsPageOutcome =
  { result: Record<string, unknown> } | { error: VariantDriftRpcError };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the overlay for one variant. Call it with each `tools/list` result
 * and the cursor its request carried; it answers `undefined` for a result that
 * isn't a page of tools. It edits the result in place.
 */
export function createToolsPageOverlay(
  variant: Pick<VariantDefinition, "variantId" | "edits" | "toolHashes">
) {
  const values = new Map(
    variant.edits.map((edit) => [edit.target, edit.value])
  );
  const pinned = new Map(
    variant.toolHashes.map((entry) => [entry.tool, entry.hash])
  );
  // Edited tools seen so far in each open listing, by the cursor of its next page.
  const open = new Map<string, Set<string>>();

  return async (
    result: Record<string, unknown>,
    cursor: string | undefined
  ): Promise<ToolsPageOutcome | undefined> => {
    if (!Array.isArray(result.tools)) return undefined;
    const edited: { tool: Record<string, unknown>; value: string }[] = [];
    const changed = new Set<string>();
    // A page whose listing started elsewhere gets the drift check only.
    const seen = cursor === undefined ? new Set<string>() : open.get(cursor);
    for (const tool of result.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") continue;
      const value = values.get(tool.name);
      if (value === undefined) continue;
      seen?.add(tool.name);
      edited.push({ tool, value });
      if ((await computeToolHash(tool)) !== pinned.get(tool.name)) {
        changed.add(tool.name);
      }
    }
    if (seen && typeof result.nextCursor === "string") {
      open.delete(result.nextCursor);
      open.set(result.nextCursor, seen);
      const oldest = open.keys().next();
      if (open.size > MAX_OPEN_LISTINGS && !oldest.done)
        open.delete(oldest.value);
    }
    if (seen && result.nextCursor === undefined) {
      for (const target of values.keys()) {
        if (!seen.has(target)) changed.add(target);
      }
    }
    if (changed.size > 0) {
      const tools = [...changed];
      return {
        error: {
          code: VARIANT_BASE_DRIFTED_RPC_CODE,
          message: variantErrorMessages.VARIANT_BASE_DRIFTED(tools),
          data: {
            code: "VARIANT_BASE_DRIFTED",
            tools,
            variantId: variant.variantId,
          },
        },
      };
    }
    for (const { tool, value } of edited) tool.description = value;
    return { result };
  };
}
