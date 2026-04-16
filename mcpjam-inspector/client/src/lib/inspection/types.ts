/**
 * Types for MCP server inspection snapshots and diffs.
 *
 * These types are used entirely within the inspector client — no backend
 * schema or Convex types are involved.
 */

// ── Normalized Snapshots ─────────────────────────────────────────────

export interface NormalizedToolSnapshot {
  name: string;
  description?: string;
  inputSchema?: object;
  outputSchema?: object;
  annotations?: object;
  /** Merged metadata: tool._meta ?? toolsMetadata[tool.name] */
  metadata?: Record<string, unknown>;
}

export interface NormalizedInitSnapshot {
  protocolVersion?: string;
  transport?: string;
  serverVersion?: { name: string; version: string; title?: string };
  instructions?: string;
  serverCapabilities?: Record<string, unknown>;
}

export interface ServerInspectionSnapshot {
  init: NormalizedInitSnapshot;
  tools: NormalizedToolSnapshot[];
  capturedAt: number;
}

// ── Diff Results ─────────────────────────────────────────────────────

export interface InitChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ToolChange {
  type: "added" | "removed" | "changed";
  name: string;
  before?: NormalizedToolSnapshot;
  after?: NormalizedToolSnapshot;
  changedFields?: string[];
}

export interface ServerInspectionDiff {
  initChanges: InitChange[];
  toolChanges: ToolChange[];
  computedAt: number;
}

// ── Storage Record ───────────────────────────────────────────────────

export interface ServerInspectionRecord {
  latestSnapshot: ServerInspectionSnapshot;
  latestDiff: ServerInspectionDiff | null;
}
