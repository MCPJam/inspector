import type { MCPClientManager, ConnectionsByServerId } from "@mcpjam/sdk";
const connections = new WeakMap<MCPClientManager, ConnectionsByServerId>();
export function setManagerConnections(
  manager: MCPClientManager,
  value: ConnectionsByServerId,
) {
  connections.set(manager, value);
}
export function getManagerConnections(
  manager: MCPClientManager,
): ConnectionsByServerId | undefined {
  return connections.get(manager);
}
export function connectionsAtTurn(manager: MCPClientManager) {
  const groups = getManagerConnections(manager);
  return groups
    ? Object.values(groups)
        .flat()
        .map((c) => ({
          serverId: c.serverId,
          connectionId: c.connectionId,
          label: c.label,
          ...(c.profile ? { profileId: c.profile.id } : {}),
        }))
    : undefined;
}

/** Account aliases are internal; catalog/eval consumers see the base once. */
export function listBaseServers(
  manager: Partial<Pick<MCPClientManager, "listServers">>,
): string[] {
  const groups = connections.get(manager as MCPClientManager);
  const internalKeys = new Set(
    Object.values(groups ?? {}).flatMap((group) => group.map((c) => c.key)),
  );
  return (manager.listServers?.() ?? []).filter(
    (key) => !internalKeys.has(key) || Object.hasOwn(groups ?? {}, key),
  );
}
export async function removeServerConnections(
  manager: MCPClientManager,
  serverKey: string,
) {
  const groups = connections.get(manager);
  if (!groups?.[serverKey]) return;
  for (const c of groups[serverKey])
    if (c.key !== serverKey) await manager.removeServer(c.key);
  const { [serverKey]: _removed, ...remaining } = groups;
  connections.set(manager, remaining);
}

const localScopes = new WeakMap<
  MCPClientManager,
  Map<string, { serverId: string; projectId: string }>
>();
export function registerLocalConnectionScope(
  manager: MCPClientManager,
  key: string,
  scope: { serverId: string; projectId: string },
) {
  const scopes = localScopes.get(manager) ?? new Map();
  scopes.set(key, scope);
  localScopes.set(manager, scopes);
}
export async function revokeLocalConnection(
  manager: MCPClientManager,
  projectId: string,
  serverId: string,
  connectionId: string,
) {
  for (const [base, scope] of localScopes.get(manager) ?? []) {
    if (scope.projectId !== projectId || scope.serverId !== serverId) continue;
    const groups = connections.get(manager) ?? {};
    const group = groups[base];
    const revoked = group?.find((c) => c.connectionId === connectionId);
    if (!group || revoked?.isDefault) await manager.removeServer(base);
    if (revoked && revoked.key !== base)
      await manager.removeServer(revoked.key);
    if (group)
      connections.set(manager, {
        ...groups,
        [base]: group.filter((c) => c.connectionId !== connectionId),
      });
  }
}
