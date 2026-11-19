import { createHash } from "node:crypto";
import type { MCPClientManager } from "@mcpjam/sdk";
import { canonicalJson } from "../tool-approval-token.js";

import { getManagerOrganization } from "../mcp-connections.js";
import { hostedWarmAgentEnabled } from "./harness-flags.js";

const warmManagers = new WeakSet<MCPClientManager>();
/**
 * Let a turn's manager re-attach to its conversation's running agent. Two
 * routes call this, each with the organization the backend verified for the
 * turn's project, never one the request named:
 *
 * - The signed-in Playground (`services/chat-turn/managed-connections.ts`),
 *   with the organization `/web/authorize-project` returned for the member.
 * - The session API (`routes/v1/chat-session-turn.ts`), behind
 *   `harnessApiWarmEnabled()`, with the organization the project's
 *   capabilities read returned for the caller's organization-scoped token.
 *
 * Both are safe for the same reasons: a manager holding servers is admitted
 * only when the backend authorized those servers for that organization, the
 * organization's own switch still applies, and the turn's warm probe checks
 * the agent before any prompt reaches it. The two routes never share a
 * conversation, so neither reaches the other's agent: the API continues only
 * sessions it created, and the Playground refuses to write to those.
 */
export function admitWarmChatManager(manager: MCPClientManager, projectOrg: string | undefined, hasServers: boolean) {
  if (hostedWarmAgentEnabled(projectOrg) && (!hasServers || getManagerOrganization(manager) === projectOrg))
    warmManagers.add(manager);
}

export function isWarmChatManager(manager: MCPClientManager): boolean {
  return warmManagers.has(manager);
}

const bindings = new WeakMap<MCPClientManager, Map<string, string>>();

export function bindWarmApprovalConnection(
  manager: MCPClientManager,
  key: string,
  account: {
    serverId: string;
    credentialId?: string;
    authorizedAt?: number | null;
    updatedAt?: number;
    defaultAccount?: boolean;
    profileId?: string;
  },
  headers?: HeadersInit,
): void {
  const effectiveHeaders = new Headers(headers);
  // Stored OAuth tokens can refresh while the approved account stays the same.
  // With caller-provided credentials, only the effective header identifies it.
  if (account.credentialId) effectiveHeaders.delete("authorization");
  const sortedHeaders: [string, string][] = [];
  effectiveHeaders.forEach((value, name) => sortedHeaders.push([name, value]));
  const digest = createHash("sha256")
    .update(canonicalJson([account, sortedHeaders.sort(([left], [right]) => left.localeCompare(right))]))
    .digest("hex");
  const byKey = bindings.get(manager) ?? new Map();
  byKey.set(key, digest);
  bindings.set(manager, byKey);
}

export function warmApprovalBindings(manager: MCPClientManager) {
  return Array.from(bindings.get(manager) ?? []).sort(([a], [b]) =>
    a.localeCompare(b),
  );
}
