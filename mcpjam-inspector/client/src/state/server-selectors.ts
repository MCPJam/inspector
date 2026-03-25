import type { ServerWithName } from "./app-types";

export function getServerSurface(
  server: ServerWithName | undefined,
): "workspace" | "learning" {
  return server?.surface ?? "workspace";
}

export function isWorkspaceVisibleServer(
  server: ServerWithName | undefined,
): boolean {
  return getServerSurface(server) === "workspace";
}

export function getWorkspaceVisibleServers(
  servers: Record<string, ServerWithName>,
): Record<string, ServerWithName> {
  return Object.fromEntries(
    Object.entries(servers).filter(([, server]) =>
      isWorkspaceVisibleServer(server),
    ),
  );
}

export function getWorkspaceVisibleConnectedServers(
  servers: Record<string, ServerWithName>,
): Record<string, ServerWithName> {
  return Object.fromEntries(
    Object.entries(servers).filter(
      ([, server]) =>
        isWorkspaceVisibleServer(server) &&
        (server.connectionStatus === "connected" ||
          server.connectionStatus === "connecting"),
    ),
  );
}

export function getWorkspaceVisibleConnectedServerNames(
  servers: Record<string, ServerWithName>,
): string[] {
  return Object.entries(servers)
    .filter(
      ([, server]) =>
        isWorkspaceVisibleServer(server) &&
        server.connectionStatus === "connected",
    )
    .map(([name]) => name);
}

export function getRuntimeServersBySurface(
  servers: Record<string, ServerWithName>,
  surface: "workspace" | "learning",
): Record<string, ServerWithName> {
  return Object.fromEntries(
    Object.entries(servers).filter(
      ([, server]) => getServerSurface(server) === surface,
    ),
  );
}
