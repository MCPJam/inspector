/**
 * Human-readable summary text for an inspection diff.
 */

import type { ServerInspectionDiff } from "./types";

/**
 * Format a diff into a scannable one-line summary like:
 * "2 tools added, 1 tool changed, instructions updated"
 */
export function formatDiffSummary(diff: ServerInspectionDiff): string {
  const parts: string[] = [];

  // Tool change counts
  const added = diff.toolChanges.filter((c) => c.type === "added").length;
  const removed = diff.toolChanges.filter((c) => c.type === "removed").length;
  const changed = diff.toolChanges.filter((c) => c.type === "changed").length;

  if (added > 0) parts.push(`${added} tool${added === 1 ? "" : "s"} added`);
  if (removed > 0)
    parts.push(`${removed} tool${removed === 1 ? "" : "s"} removed`);
  if (changed > 0)
    parts.push(`${changed} tool${changed === 1 ? "" : "s"} changed`);

  // Init changes — list the specific fields
  if (diff.initChanges.length > 0) {
    const fields = diff.initChanges.map((c) => formatInitFieldName(c.field));
    parts.push(fields.join(", ") + " updated");
  }

  return parts.join(", ");
}

function formatInitFieldName(field: string): string {
  switch (field) {
    case "protocolVersion":
      return "protocol version";
    case "transport":
      return "transport";
    case "serverVersion":
      return "server version";
    case "instructions":
      return "instructions";
    case "serverCapabilities":
      return "capabilities";
    default:
      return field;
  }
}
