import { createHash } from "node:crypto";
import type { MCPClientManager } from "@mcpjam/sdk";
import { canonicalJson } from "../tool-approval-token.js";

import { getManagerOrganization } from "../mcp-connections.js";
import { hostedWarmAgentEnabled } from "./harness-flags.js";

const warmManagers = new WeakSet<MCPClientManager>();
/** Only the signed-in Playground's project check can admit a manager. */
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
