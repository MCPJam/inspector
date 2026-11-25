/**
 * The head of the ranked list of what can change, sized for an agent's tool
 * result. A server with hundreds of tools lists thousands of entries, and the
 * MCP Worker shows a model only the first 24,000 characters of a result. The
 * list is ranked, so the head is what to try first; the full list stays with
 * `get_mock_server`, and a screen reads it from the climb route unbounded.
 */
import type { ChangeEntry } from "./types.js";

export const MAX_TOP_CHANGES = 15;
/** Characters of JSON the kept entries may take, so long current values cannot crowd out the rest of the climb. */
export const TOP_CHANGES_BUDGET = 8_000;

export function topChanges(entries: readonly ChangeEntry[]): { entries: ChangeEntry[]; total: number; note?: string } {
  const kept: ChangeEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const next = size + JSON.stringify(entry).length;
    if (kept.length === MAX_TOP_CHANGES || (kept.length > 0 && next > TOP_CHANGES_BUDGET)) break;
    kept.push(entry);
    size = next;
  }
  if (kept.length === entries.length) return { entries: kept, total: entries.length };
  return {
    entries: kept,
    total: entries.length,
    note: `\`whatCanChange\` shows the top ${kept.length} of ${entries.length} entries, best first. \`get_mock_server\` lists every entry.`,
  };
}
