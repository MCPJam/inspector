/**
 * What the mock server routes share: the backend calls, a read of one mock, a
 * read of the real server as the caller, and the shape of a saved version.
 */
import type { Context } from "hono";
import { makeFunctionReference } from "convex/server";
import { listAllPrompts, listAllResources, listAllResourceTemplates, listAllTools } from "@mcpjam/sdk/operations";
import type { PlatformMockLoosened, PlatformMockSaved } from "@mcpjam/sdk/platform";
import { projectServerSchema, runEphemeralConnection } from "../web/auth.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { mockServerAddress } from "../../services/mock/address.js";
import { createConvexClient } from "./convex-client.js";
import { translateMockReadError, type RealServerRead } from "./mock-server-support.js";

export const fn = {
  create: makeFunctionReference<"mutation">("mockServers:createMock"),
  save: makeFunctionReference<"mutation">("mockServers:saveMockVersion"),
  get: makeFunctionReference<"query">("mockServers:getMock"),
};


/** `mockServers:getMock`'s row. The definition and the saved listing cross Convex as JSON text. */
export type MockRow = {
  mockId: string;
  projectId: string;
  name: string;
  baseServerId: string | null;
  headVersion: number;
  version: number;
  contentHash: string;
  definitionJson: string;
  /** This caller's saved listing of the real server; null when none, or when it is another member's private one. */
  discovery?: { visibility: "project" | "caller"; listingJson: string } | null;
  hasDiscovery?: boolean;
  loosened?: PlatformMockLoosened[];
  createdAt?: number;
};

export async function readMock(c: Context, projectId: string, mockId: string, version?: number): Promise<MockRow> {
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  let row: MockRow;
  try {
    row = await convex.query(fn.get, { mockId, ...(version !== undefined ? { version } : {}) });
  } catch (error) {
    throw translateMockReadError(error);
  }
  // The path names a project; a mock in another one is not found here.
  if (row.projectId !== projectId) throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Mock server not found");
  return row;
}

/** The real server as it is now, read on a connection made as the caller. */
export async function readRealServer(c: Context, projectId: string, serverId: string): Promise<RealServerRead> {
  return runEphemeralConnection<typeof projectServerSchema, RealServerRead>(c, { projectId, serverId }, projectServerSchema, async (manager, body) => {
    const id = body.serverId;
    const { tools } = await listAllTools(manager, { serverId: id, cacheMode: "bypass" });
    const info = manager.getInitializationInfo(id);
    const capabilities = info?.serverCapabilities;
    // A family the real server does not declare has nothing to read.
    return {
      tools,
      serverInfo: info?.serverVersion,
      instructions: info?.instructions,
      capabilities,
      ...(capabilities?.prompts
        ? { prompts: (await listAllPrompts(manager, { serverId: id, cacheMode: "bypass" })).prompts }
        : {}),
      ...(capabilities?.resources
        ? {
            resources: (await listAllResources(manager, { serverId: id, cacheMode: "bypass" })).resources,
            resourceTemplates: (await listAllResourceTemplates(manager, { serverId: id, cacheMode: "bypass" }))
              .resourceTemplates,
          }
        : {}),
    };
  });
}

export type SavedFields = Omit<PlatformMockSaved, "address" | "created" | "loosened">;

export function saved(fields: SavedFields, result: { created: boolean; loosened?: PlatformMockLoosened[] }): PlatformMockSaved {
  return { ...fields, address: mockServerAddress(fields.id), created: result.created, loosened: result.loosened ?? [] };
}

/** A save against a head that has moved on, as the backend reports it. */
export function staleHead(headVersion: number): WebRouteError {
  return new WebRouteError(
    409,
    ErrorCode.CONFLICT,
    `The mock changed since you read it: its head is version ${headVersion}. Read it again, then retry against that version.`,
    { code: "MOCK_VERSION_STALE", headVersion },
  );
}

export async function bearerOf(c: Context): Promise<string> {
  return getConvexBearerForRequest(c);
}
export { createConvexClient };
