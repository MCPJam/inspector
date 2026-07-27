/**
 * Tasks wire resolver — the single seam that decides HOW (or whether) a
 * task-augmented request reaches the wire for a given connection.
 *
 * Background: MCP tasks were first specified for 2025-11-25 as the in-core
 * experimental utility, where the `task` field rides inside the request
 * PARAMS (e.g. `tools/call` `params: { name, arguments, task: { ttl } }`).
 * The 2026-07-28 era relocates tasks to the `io.modelcontextprotocol/tasks`
 * extension (SEP-2663) with a different wire — not yet implemented here.
 *
 * This module keeps that routing decision in one place so the executeTool
 * path and the capability probes agree, and so the follow-up extension PR
 * has a single spot to add the `"extension"` branch.
 */

import type { ServerCapabilities } from "@modelcontextprotocol/client";
import { isKnownProtocolVersion } from "./mcp-protocol-version.js";

/**
 * How task-augmented requests are carried on a connection:
 *   - `"legacy"`    — 2025-11-25 in-params `task` field.
 *   - `"extension"` — 2026-07-28 `io.modelcontextprotocol/tasks` extension
 *                     wire (SEP-2663). Reserved; a follow-up PR returns it.
 *   - `"none"`      — tasks are not routable on this connection.
 */
export type TasksWire = "legacy" | "extension" | "none";

/**
 * Loose view over the two namespaces the legacy (2025-11-25) tasks
 * capability can appear in. Deliberately narrow: it must NOT match the
 * 2026-07-28 `extensions` capability, which is a different feature.
 */
type LegacyTasksCapabilityView = {
  tasks?: unknown;
  experimental?: { tasks?: unknown } | undefined;
};

function hasLegacyTasksCapability(
  caps: ServerCapabilities | undefined
): boolean {
  const view = caps as LegacyTasksCapabilityView | undefined;
  return Boolean(view?.tasks || view?.experimental?.tasks);
}

/**
 * Resolve which tasks wire (if any) applies to a connection.
 *
 * Fails closed: an unknown or absent negotiated version routes to
 * `"none"` (per the validate-then-route discipline in
 * `mcp-protocol-version.ts` — unknown values must never be routed).
 */
export function resolveTasksWire(
  negotiatedVersion: string | undefined,
  caps: ServerCapabilities | undefined
): TasksWire {
  if (negotiatedVersion === undefined) {
    return "none";
  }
  if (!isKnownProtocolVersion(negotiatedVersion)) {
    return "none";
  }

  switch (negotiatedVersion) {
    case "2025-11-25":
      // Only version whose in-params `task` wire this SDK speaks. The
      // capability may live under either the top-level `tasks` or the
      // `experimental.tasks` namespace.
      return hasLegacyTasksCapability(caps) ? "legacy" : "none";
    case "2025-03-26":
    case "2025-06-18":
      // Tasks predate these versions. Return "none" even when a server
      // erroneously advertises a tasks capability — closes a known gap
      // where old-version servers surfaced task UI they cannot honor.
      return "none";
    case "2026-07-28":
      // The `io.modelcontextprotocol/tasks` extension wire is not
      // implemented yet; a follow-up PR returns "extension" here. Never
      // treat the `extensions` capability as the legacy tasks wire.
      return "none";
    default:
      return "none";
  }
}
