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

/**
 * Whether a negotiated version is in the era that can carry the tasks
 * extension. Fails closed on unknown/missing versions, so era-gated wire
 * hacks (result rewriting, routing headers) never fire on older traffic.
 */
export function isTasksExtensionEra(
  protocolVersion: string | undefined
): boolean {
  return (
    !!protocolVersion &&
    isKnownProtocolVersion(protocolVersion) &&
    protocolVersion >= FIRST_EXTENSION_VERSION
  );
}

/** The only version that carries the in-core (legacy) tasks utility. */
const LEGACY_TASKS_VERSION = "2025-11-25";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a server advertises `io.modelcontextprotocol/tasks` in
 * `capabilities.extensions`. Only `tasks-dispatch` and `tasks-ext` may
 * consult this — the "treat as absent on 2025-11-25" rule lives here.
 *
 * The VALUE must itself be a non-array object: the capability map is
 * `{ [extensionId]: settingsObject }`, so `true` / `"x"` / `[]` / `null` are
 * malformed and do NOT count as a declaration (key presence alone would let a
 * garbage value route real `tasks/*` traffic). A NON-EMPTY object is accepted:
 * SEP-2663 says the settings are "not currently defined", so rejecting unknown
 * settings would be forward-incompatible.
 */
export function serverDeclaresTasksExtension(
  capabilities: ServerCapabilities | undefined
): boolean {
  const extensions = (capabilities as { extensions?: unknown } | undefined)
    ?.extensions;
  if (!isRecord(extensions)) {
    return false;
  }
  const settings = Object.prototype.hasOwnProperty.call(
    extensions,
    MCP_TASKS_EXTENSION_ID
  )
    ? extensions[MCP_TASKS_EXTENSION_ID]
    : undefined;
  return isRecord(settings);
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

/**
 * Everything a caller (route, UI, CLI) needs to know about a connection's
 * tasks capability, derived in ONE place so no other module has to know the
 * per-wire rules.
 */
export interface TasksSupport {
  wire: TasksWire;
  /** A `tools/call` may produce a task on this connection. */
  toolCalls: boolean;
  /** `tasks/list` exists (legacy only; on the extension the client tracks). */
  list: boolean;
  /** `tasks/cancel` may be sent. */
  cancel: boolean;
  /** `tasks/update` exists (extension only). */
  update: boolean;
  /** A completed `tasks/get` carries its result inline (extension only). */
  inlineResult: boolean;
}

const NO_TASKS_SUPPORT: TasksSupport = {
  wire: "none",
  toolCalls: false,
  list: false,
  cancel: false,
  update: false,
  inlineResult: false,
};

/**
 * Resolves the full tasks support matrix for a connection. This module is the
 * only place allowed to consult the extension capability, which is what keeps
 * the "treat as absent on 2025-11-25" rule honest.
 */
export function resolveTasksSupport(
  protocolVersion: string | undefined,
  capabilities: ServerCapabilities | undefined
): TasksSupport {
  const wire = resolveTasksWire(protocolVersion, capabilities);

  if (wire === "legacy") {
    return {
      wire,
      toolCalls: supportsTasksForToolCalls(capabilities),
      list: supportsTasksList(capabilities),
      cancel: supportsTasksCancel(capabilities),
      update: false,
      inlineResult: false,
    };
  }

  if (wire === "extension") {
    // SEP-2663 has no per-operation capability sub-flags: declaring the
    // extension declares the whole method set.
    return {
      wire,
      toolCalls: true,
      list: false,
      cancel: true,
      update: true,
      inlineResult: true,
    };
  }

  return { ...NO_TASKS_SUPPORT };
}
