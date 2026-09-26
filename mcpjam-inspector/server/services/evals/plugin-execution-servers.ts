import type { RunPluginServer } from "../plugins/run-plugin-servers.js";

type EnvironmentServerBinding = {
  serverName: string;
  projectServerId?: string;
  workspaceServerId?: string;
};

type ExecutionConfig = {
  environment?: {
    servers?: string[];
    serverBindings?: EnvironmentServerBinding[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/**
 * The server set a suite run EXECUTES: its frozen selection plus the plugin
 * servers the execution-time re-gate just verified.
 *
 * The run snapshot's `environment.servers` holds the environment's server
 * group only: plugin server ids are provenance (`pluginServerIds`), never part
 * of a persisted host config. The runner builds the model's tools from
 * `environment.servers`, so without this a plugin-only environment offered the
 * model no tools at all and a mixed one offered only its group's, while the
 * plugin servers sat connected and unused.
 *
 * Only the RE-GATED servers are added (the caller fails the run closed when a
 * pin became unavailable), each by the key the manager connected it under,
 * with a binding so the runner's id/name resolution finds it. The result lives
 * in memory for this execution; nothing here is written back.
 */
export function withPluginExecutionServers<T extends ExecutionConfig>(
  config: T,
  pluginServers: readonly RunPluginServer[],
  manager: { hasServer(serverId: string): boolean },
): T {
  if (pluginServers.length === 0) return config;
  const environment = config.environment ?? {};
  const servers = [...(environment.servers ?? [])];
  const serverBindings = [...(environment.serverBindings ?? [])];
  for (const plugin of pluginServers) {
    const ref = manager.hasServer(plugin.serverId)
      ? plugin.serverId
      : plugin.name;
    if (!servers.includes(ref) && !servers.includes(plugin.serverId)) {
      servers.push(ref);
    }
    if (
      !serverBindings.some(
        (binding) => binding.projectServerId === plugin.serverId,
      )
    ) {
      serverBindings.push({
        serverName: plugin.name,
        projectServerId: plugin.serverId,
      });
    }
  }
  return {
    ...config,
    environment: { ...environment, servers, serverBindings },
  };
}
