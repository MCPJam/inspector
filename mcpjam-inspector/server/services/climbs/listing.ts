/**
 * The real server's listing, read as the caller, and its hash.
 *
 * A climb records the hash on every run so a round whose real server changed
 * since the best so far was measured is not decided (decision 11). The hash is
 * of the real listing, never of the mock's: the mock's own answer is the
 * thing under test.
 */
import type { Context } from "hono";
import type { Tool } from "@modelcontextprotocol/server";
import { listAllTools } from "@mcpjam/sdk/operations";
import { hashRealToolListing } from "@mcpjam/sdk/mocks";
import type { ReplacementSpec, ServerReplacementInput } from "./replacement.js";
import { projectServerSchema, runEphemeralConnection } from "../../routes/web/auth.js";

/** What the real server lists and says of itself, as the caller sees it. */
export type RealServer = {
  tools: Tool[];
  serverInfo?: { name: string; version: string; title?: string };
  instructions?: string;
};

export async function readRealServer(c: Context, projectId: string, serverId: string): Promise<RealServer> {
  return runEphemeralConnection(c, { projectId, serverId }, projectServerSchema, async (manager, body) => {
    const { tools } = await listAllTools(manager, { serverId: body.serverId, cacheMode: "bypass" });
    const info = manager.getInitializationInfo(body.serverId);
    return { tools: tools as Tool[], serverInfo: info?.serverVersion, instructions: info?.instructions };
  });
}

/** Every tool the real server lists, each exactly as it listed it. */
export async function readRealTools(c: Context, projectId: string, serverId: string): Promise<Tool[]> {
  return runEphemeralConnection(c, { projectId, serverId }, projectServerSchema, async (manager, body) => {
    const { tools } = await listAllTools(manager, { serverId: body.serverId, cacheMode: "bypass" });
    return tools as Tool[];
  });
}

export async function hashRealServerListing(c: Context, projectId: string, serverId: string): Promise<string> {
  return hashRealToolListing(await readRealTools(c, projectId, serverId));
}

/** What a launch body says about the servers it replaces, in the shape `resolveLaunchServers` takes. */
export function replacementSpec(
  c: Context,
  projectId: string,
  body: { serverReplacements?: ServerReplacementInput[]; climbId?: string },
): ReplacementSpec {
  return {
    list: body.serverReplacements ?? [],
    ...(body.climbId ? { climbId: body.climbId } : {}),
    hashFor: (realServerId: string) => hashRealServerListing(c, projectId, realServerId),
  };
}
