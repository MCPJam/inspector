/**
 * Opens a mock's real server as the caller: the caller's own authorization of
 * the base server, with the caller's own credentials, never the mock's. The
 * manager is lazy, so authorizing contacts only the backend; the route
 * connects to the base itself, and only once a forward is allowed.
 *
 * Its traffic goes on the RPC log bus under a scope of its own
 * (`mock:<id>`), so it is the mock's and is not mistaken for the member's own
 * connection to that server: views that read the bus without a scope never
 * list it.
 */
import type { MCPClientManager, MCPServerConfig } from "@mcpjam/sdk";
import { createAuthorizedManager, type ManagerCallerContext } from "../../routes/web/auth.js";
import { rpcLogBus } from "../rpc-log-bus.js";
import type { ResolvedMock } from "./backend.js";
import type { MockDialProfile } from "./registry.js";

export interface OpenedReal {
  manager: MCPClientManager;
  /** The authorized config to connect with; the manager is lazy and holds none. */
  config: MCPServerConfig;
}

export type OpenReal = (args: {
  resolved: ResolvedMock;
  caller: ManagerCallerContext;
  bearerToken: string;
  profile: MockDialProfile;
}) => Promise<OpenedReal>;

export const openAuthorizedReal: OpenReal = async ({ resolved, caller, bearerToken, profile }) => {
  const id = resolved.baseServerId as string;
  const result = await createAuthorizedManager(
    caller,
    bearerToken,
    resolved.projectId,
    [id],
    profile.timeoutMs,
    undefined,
    profile.clientCapabilities,
    {
      lazyConnect: true,
      pluginComputerRuntime: false,
      // The forward passes the real tool's progress on through its own callback.
      ownsProgress: true,
      initializePins: profile.initializePins,
      xaaIssuer: profile.xaaIssuer,
      rpcLogger: ({ direction, message, serverId }) =>
        rpcLogBus.publish({
          scopeId: `mock:${resolved.mockId}`,
          serverId,
          direction,
          timestamp: new Date().toISOString(),
          message,
        }),
    },
  );
  const config = result.authorizedServerConfigs?.[id];
  if (!config) {
    await result.manager.disconnectAllServers();
    throw new Error("The real server was not authorized for this caller.");
  }
  return { manager: result.manager, config };
};
