export function getNewlyConnectedServers(
  previousConnectedServers: ReadonlySet<string> | null,
  connectedServers: ReadonlySet<string>,
): string[] {
  if (previousConnectedServers == null) {
    return [];
  }

  return Array.from(connectedServers).filter(
    (serverName) => !previousConnectedServers.has(serverName),
  );
}
