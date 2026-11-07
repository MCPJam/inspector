import { resolveProject } from "@mcpjam/sdk/platform";
import { resolveCloudProjectArgs } from "./cloud-scope.js";
import { usageError } from "./output.js";
import { resolvePlatformCredential } from "./platform-auth.js";
import {
  buildPlatformClient,
  type PlatformClientOptions,
} from "./platform-client.js";

export interface InspectorProjectTarget {
  projectId: string;
  serverId: string;
  serverName: string;
  accessToken: string;
}

export interface InspectorProjectOptions extends PlatformClientOptions {
  project?: string;
  serverId?: string;
  url?: string;
  command?: string;
}

/** Resolve a saved server without reinterpreting an ad-hoc server configuration. */
export async function resolveInspectorProjectTarget(
  options: InspectorProjectOptions,
): Promise<InspectorProjectTarget | undefined> {
  if (!options.serverId) return undefined;
  if (options.url || options.command) {
    throw usageError(
      "--server-id cannot be combined with --url or --command. Choose a saved server or an ad-hoc configuration.",
    );
  }
  const { client } = buildPlatformClient(options);
  const selector = resolveCloudProjectArgs(options).project;
  const projects = await client.listProjects();
  const resolved = resolveProject(projects.items, selector);
  if (!resolved.ok) throw usageError(resolved.message);
  const servers = await client.listProjectServers({
    projectId: resolved.project.id,
  });
  const server = servers.items.find((item) => item.id === options.serverId);
  if (!server)
    throw usageError(
      `Server "${options.serverId}" is not saved in project "${resolved.project.name}". Choose a server from that project.`,
    );
  return {
    projectId: resolved.project.id,
    serverId: server.id,
    serverName: server.name,
    accessToken: await resolvePlatformCredential(options).getAuth(),
  };
}
