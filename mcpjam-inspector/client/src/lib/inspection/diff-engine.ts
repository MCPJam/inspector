/**
 * Pure, side-effect-free diff engine for MCP server inspection snapshots.
 *
 * All functions are deterministic — same inputs always produce same outputs.
 * Object key ordering is normalized via stableStringify to avoid false diffs.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { InitializationInfo } from "@/state/app-types";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import type {
  NormalizedToolSnapshot,
  NormalizedInitSnapshot,
  ServerInspectionSnapshot,
  ServerInspectionDiff,
  InitChange,
  ToolChange,
} from "./types";

// ── Stable Serialization ─────────────────────────────────────────────

/**
 * Deterministic JSON.stringify with recursively sorted keys.
 * Produces identical output regardless of object key insertion order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((sorted, k) => {
          sorted[k] = (val as Record<string, unknown>)[k];
          return sorted;
        }, {});
    }
    return val;
  });
}

/**
 * Deep-equal comparison using stable serialization.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Stable-sort the keys of an object recursively so stored snapshots
 * are deterministic.
 */
function stabilize<T>(value: T): T {
  return JSON.parse(stableStringify(value)) as T;
}

// ── Normalization ────────────────────────────────────────────────────

/**
 * Normalize a raw MCP Tool into a snapshot-safe shape.
 *
 * Merges metadata via `tool._meta ?? externalMetadata` to match the
 * existing UI behavior in ServerInfoToolsMetadataContent.
 */
export function normalizeToolSnapshot(
  tool: Tool,
  externalMetadata?: Record<string, unknown>,
): NormalizedToolSnapshot {
  const merged =
    (tool._meta as Record<string, unknown> | undefined) ?? externalMetadata;
  const snapshot: NormalizedToolSnapshot = { name: tool.name };

  if (tool.description !== undefined) snapshot.description = tool.description;
  if (tool.inputSchema !== undefined)
    snapshot.inputSchema = tool.inputSchema as object;
  if ((tool as any).outputSchema !== undefined)
    snapshot.outputSchema = (tool as any).outputSchema as object;
  if (tool.annotations !== undefined)
    snapshot.annotations = tool.annotations as object;
  if (merged !== undefined) snapshot.metadata = merged;

  return stabilize(snapshot);
}

/**
 * Normalize server-facing initialization info.
 * Explicitly excludes `clientCapabilities` — that reflects the client
 * profile, not server behavior.
 */
export function normalizeInitSnapshot(
  info: InitializationInfo,
): NormalizedInitSnapshot {
  const snapshot: NormalizedInitSnapshot = {};

  if (info.protocolVersion !== undefined)
    snapshot.protocolVersion = info.protocolVersion;
  if (info.transport !== undefined) snapshot.transport = info.transport;
  if (info.serverVersion !== undefined) {
    snapshot.serverVersion = {
      name: info.serverVersion.name,
      version: info.serverVersion.version,
      ...(info.serverVersion.title !== undefined
        ? { title: info.serverVersion.title }
        : {}),
    };
  }
  if (info.instructions !== undefined)
    snapshot.instructions = info.instructions;
  if (info.serverCapabilities !== undefined)
    snapshot.serverCapabilities = info.serverCapabilities;

  // clientCapabilities is intentionally excluded

  return stabilize(snapshot);
}

/**
 * Build a full inspection snapshot from init info and the tools/list result.
 *
 * Accepts `ListToolsResultWithMetadata` so it can merge the separate
 * `toolsMetadata` record into each tool's normalized snapshot.
 */
export function buildSnapshot(
  init: InitializationInfo,
  toolsResult: ListToolsResultWithMetadata,
): ServerInspectionSnapshot {
  const toolsMetadata = toolsResult.toolsMetadata ?? {};
  const tools = (toolsResult.tools ?? []).map((tool: Tool) =>
    normalizeToolSnapshot(
      tool,
      toolsMetadata[tool.name] as Record<string, unknown> | undefined,
    ),
  );

  // Sort tools by name for deterministic ordering
  tools.sort((a, b) => a.name.localeCompare(b.name));

  return {
    init: normalizeInitSnapshot(init),
    tools,
    capturedAt: Date.now(),
  };
}

// ── Diff Computation ─────────────────────────────────────────────────

/** Fields compared on each NormalizedToolSnapshot. */
const TOOL_DIFF_FIELDS: (keyof NormalizedToolSnapshot)[] = [
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
  "metadata",
];

/** Fields compared on NormalizedInitSnapshot. */
const INIT_DIFF_FIELDS: (keyof NormalizedInitSnapshot)[] = [
  "protocolVersion",
  "transport",
  "serverVersion",
  "instructions",
  "serverCapabilities",
];

/**
 * Compute a semantic diff between two inspection snapshots.
 *
 * For tools: detects added, removed, and changed tools, listing which
 * fields changed for each modified tool.
 *
 * For init: detects field-level changes for all server-facing fields.
 */
export function computeInspectionDiff(
  prev: ServerInspectionSnapshot,
  current: ServerInspectionSnapshot,
): ServerInspectionDiff {
  // ── Init changes ─────────────────────────────────────────────────
  const initChanges: InitChange[] = [];
  for (const field of INIT_DIFF_FIELDS) {
    const before = prev.init[field];
    const after = current.init[field];
    if (!deepEqual(before, after)) {
      initChanges.push({ field, before, after });
    }
  }

  // ── Tool changes ─────────────────────────────────────────────────
  const prevByName = new Map(prev.tools.map((t) => [t.name, t]));
  const currentByName = new Map(current.tools.map((t) => [t.name, t]));
  const toolChanges: ToolChange[] = [];

  // Added tools (in current but not in prev)
  for (const [name, after] of currentByName) {
    if (!prevByName.has(name)) {
      toolChanges.push({ type: "added", name, after });
    }
  }

  // Removed tools (in prev but not in current)
  for (const [name, before] of prevByName) {
    if (!currentByName.has(name)) {
      toolChanges.push({ type: "removed", name, before });
    }
  }

  // Changed tools (in both, but with field differences)
  for (const [name, after] of currentByName) {
    const before = prevByName.get(name);
    if (!before) continue;

    const changedFields: string[] = [];
    for (const field of TOOL_DIFF_FIELDS) {
      if (!deepEqual(before[field], after[field])) {
        changedFields.push(field);
      }
    }

    if (changedFields.length > 0) {
      toolChanges.push({ type: "changed", name, before, after, changedFields });
    }
  }

  // Sort tool changes: added first, then changed, then removed, alpha within each
  toolChanges.sort((a, b) => {
    const order = { added: 0, changed: 1, removed: 2 };
    const typeCompare = order[a.type] - order[b.type];
    if (typeCompare !== 0) return typeCompare;
    return a.name.localeCompare(b.name);
  });

  return {
    initChanges,
    toolChanges,
    computedAt: Date.now(),
  };
}

/**
 * Returns true if the diff contains at least one meaningful change.
 */
export function hasMeaningfulChanges(diff: ServerInspectionDiff): boolean {
  return diff.initChanges.length > 0 || diff.toolChanges.length > 0;
}
