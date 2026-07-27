/**
 * Tasks wire dispatch — the single place that decides *which* tasks wire (if
 * any) a given connection speaks.
 *
 * Two mutually exclusive wires exist:
 *
 *   - `"legacy"` — the in-core 2025-11-25 experimental tasks utility
 *     (`params.task = {ttl?}`, `tasks/list|get|result|cancel`).
 *   - `"extension"` — `io.modelcontextprotocol/tasks` (SEP-2663), the
 *     2026-07-28+ extension. Server-decided, no `params.task`.
 *
 * Routing rules (see the dispatch matrix in the tasks restoration plan):
 *
 *   | version            | legacy caps | extension cap | wire        |
 *   |--------------------|-------------|---------------|-------------|
 *   | 2025-03-26/06-18   | ignored     | ignored       | none        |
 *   | 2025-11-25         | present     | treated absent| legacy      |
 *   | 2025-11-25         | absent      | ignored       | none        |
 *   | >= 2026-07-28      | ignored     | present       | extension   |
 *   | >= 2026-07-28      | ignored     | absent        | none        |
 *
 * Unknown / absent versions **fail closed** to `"none"` — an unvalidated
 * version string must never route (see `mcp-protocol-version.ts`).
 */

import type { ServerCapabilities } from "@modelcontextprotocol/client";
import {
  isKnownProtocolVersion,
  type McpProtocolVersion,
} from "./mcp-protocol-version.js";
import {
  supportsTasksCancel,
  supportsTasksForToolCalls,
  supportsTasksList,
} from "./tasks.js";

/** Extension id for the SEP-2663 tasks extension. */
export const MCP_TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks" as const;

/** The tasks wire a connection speaks. */
export type TasksWire = "none" | "legacy" | "extension";

/**
 * Protocol version that first carries the tasks extension. Versions are
 * date-ordered wire literals, so lexicographic comparison is the ordering.
 */
const FIRST_EXTENSION_VERSION = "2026-07-28";

/** The only version that carries the in-core (legacy) tasks utility. */
const LEGACY_TASKS_VERSION = "2025-11-25";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a server advertises `io.modelcontextprotocol/tasks` in
 * `capabilities.extensions`. Only `tasks-dispatch` and `tasks-ext` may
 * consult this — the "treat as absent on 2025-11-25" rule lives here.
 */
export function serverDeclaresTasksExtension(
  capabilities: ServerCapabilities | undefined
): boolean {
  const extensions = (capabilities as { extensions?: unknown } | undefined)
    ?.extensions;
  return isRecord(extensions) && MCP_TASKS_EXTENSION_ID in extensions;
}

/**
 * Resolves the tasks wire for a connection. Fails closed on an unknown or
 * missing negotiated protocol version.
 */
export function resolveTasksWire(
  protocolVersion: string | undefined,
  capabilities: ServerCapabilities | undefined
): TasksWire {
  if (!protocolVersion || !isKnownProtocolVersion(protocolVersion)) {
    return "none";
  }
  const version: McpProtocolVersion = protocolVersion;

  if (version >= FIRST_EXTENSION_VERSION) {
    return serverDeclaresTasksExtension(capabilities) ? "extension" : "none";
  }

  if (version === LEGACY_TASKS_VERSION) {
    // SEP-2663: on 2025-11-25 the extension capability MUST be treated as
    // absent — the in-core utility is the only wire.
    return supportsTasksForToolCalls(capabilities) ||
      supportsTasksList(capabilities) ||
      supportsTasksCancel(capabilities)
      ? "legacy"
      : "none";
  }

  return "none";
}
