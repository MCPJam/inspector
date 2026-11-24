/**
 * Public `/api/v1` mock servers: create one, save its next version, read a
 * version. The definition is checked here, with the SDK's validator and the
 * real server's current tools, before the backend stores it: the checks need
 * Node-only code, and the route gives every surface the same refusals. The
 * tiers and the `climbs` flag are the backend's, called with the caller's own
 * bearer: creating and saving need both, reading needs the view tier only.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { makeFunctionReference } from "convex/server";
import { diffMockDefinitions, type MockChange, type MockDefinition } from "@mcpjam/sdk/mocks";
import {
  listAllPrompts,
  listAllResources,
  listAllResourceTemplates,
  listAllTools,
} from "@mcpjam/sdk/operations";
import { ALL_CLIENTS, whatCanChange } from "@mcpjam/sdk/climbs";
import type {
  PlatformMockSaved,
  PlatformMockServer,
  PlatformMockUnmatchedCall,
} from "@mcpjam/sdk/platform";
import { projectServerSchema, runEphemeralConnection } from "../web/auth.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { logger } from "../../utils/logger.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { mockServerAddress } from "../../services/mock/address.js";
import { readJsonObjectBody, runV1ServerOp } from "./adapter.js";
import { createConvexClient } from "./convex-client.js";
import { requireProjectIdArg } from "./convex-id-param.js";
import { v1Resource } from "./envelope.js";
import {
  applyMergePatch,
  assertCallable,
  describeRealEdits,
  translateMockReadError,
  translateMockWriteError,
  validatedDefinition,
  type RealServerRead,
} from "./mock-server-support.js";

const mockServers = new Hono();

const fn = {
  create: makeFunctionReference<"mutation">("mockServers:createMock"),
  save: makeFunctionReference<"mutation">("mockServers:saveMockVersion"),
  get: makeFunctionReference<"query">("mockServers:getMock"),
  unmatched: makeFunctionReference<"query">("mockAnswers:listUnmatchedCalls"),
};

/** `mockServers:getMock`'s row. The definition crosses Convex as JSON text. */
type MockRow = {
  mockId: string;
  projectId: string;
  name: string;
  baseServerId: string | null;
  headVersion: number;
  version: number;
  contentHash: string;
  definitionJson: string;
  createdAt?: number;
};

const object = z.record(z.string(), z.unknown());
const createBody = z.strictObject({
  name: z.string().trim().min(1),
  serverId: z.string().trim().min(1).optional(),
  definition: object,
});
const saveBody = z
  .strictObject({
    definition: object.optional(),
    patch: object.optional(),
    expectedVersion: z.number().int().min(1),
    dryRun: z.boolean().optional(),
  })
  .refine((body) => (body.definition === undefined) !== (body.patch === undefined), {
    message: "Give exactly one of `definition` and `patch`.",
  });
const versionQuery = z.object({
  version: z.coerce.number().int().min(1).optional(),
  since: z.coerce.number().int().min(1).optional(),
});

function projectIdOf(c: Context): string {
  const projectId = c.req.param("projectId") ?? "";
  requireProjectIdArg(projectId, "v1.mock-servers");
  return projectId;
}

async function readMock(c: Context, projectId: string, mockId: string, version?: number): Promise<MockRow> {
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

/**
 * The real server's tools and handshake, on a connection made as the caller;
 * with a definition, also the prompts, resources and templates it edits.
 */
async function listReal(
  manager: Parameters<typeof listAllTools>[0],
  serverId: string,
  definition?: MockDefinition,
): Promise<RealServerRead> {
  const { tools } = await listAllTools(manager, { serverId, cacheMode: "bypass" });
  const info = manager.getInitializationInfo(serverId);
  const wants = (map: object | undefined) => map !== undefined && Object.keys(map).length > 0;
  const capabilities = info?.serverCapabilities;
  return {
    tools,
    serverInfo: info?.serverVersion,
    instructions: info?.instructions,
    // A family the real server does not declare has nothing to read.
    ...(wants(definition?.prompts) && capabilities?.prompts
      ? { prompts: (await listAllPrompts(manager, { serverId, cacheMode: "bypass" })).prompts }
      : {}),
    ...(wants(definition?.resources) && capabilities?.resources
      ? { resources: (await listAllResources(manager, { serverId, cacheMode: "bypass" })).resources }
      : {}),
    ...(wants(definition?.resourceTemplates) && capabilities?.resources
      ? {
          resourceTemplates: (
            await listAllResourceTemplates(manager, { serverId, cacheMode: "bypass" })
          ).resourceTemplates,
        }
      : {}),
  };
}

/** Runs `then` with the real server read as the caller (a mock from nothing has none). */
function withReal(
  c: Context,
  projectId: string,
  baseServerId: string | null | undefined,
  then: (c: Context, real?: RealServerRead) => Promise<Response>,
): Promise<Response> {
  if (!baseServerId) return then(c);
  return runV1ServerOp(c, projectServerSchema, (manager, body) => listReal(manager, body.serverId), then, {
    body: { projectId, serverId: baseServerId },
  });
}

type SavedFields = Omit<PlatformMockSaved, "address" | "changes" | "created" | "dryRun">;

function saved(
  fields: SavedFields,
  changes: MockChange[],
  state: Pick<PlatformMockSaved, "created" | "dryRun">,
): PlatformMockSaved {
  return { ...fields, ...state, address: mockServerAddress(fields.id), changes };
}

// POST /v1/projects/:projectId/mock-servers: create a mock, version 1.
mockServers.post("/projects/:projectId/mock-servers", async (c) => {
  const projectId = projectIdOf(c);
  const body = parseWithSchema(createBody, await readJsonObjectBody(c));
  const definition = validatedDefinition(body.definition);
  const token = await getConvexBearerForRequest(c);
  return withReal(c, projectId, body.serverId, async (ctx, real) => {
    if (real) assertCallable(definition, real);
    let created: { mockId: string; version: number; contentHash: string };
    try {
      created = await createConvexClient(token).mutation(fn.create, {
        projectId,
        ...(body.serverId ? { baseServerId: body.serverId } : {}),
        name: body.name,
        definitionJson: JSON.stringify(definition),
      });
    } catch (error) {
      throw translateMockWriteError(error);
    }
    const fields = {
      id: created.mockId,
      name: body.name,
      projectId,
      baseServerId: body.serverId ?? null,
      version: created.version,
      contentHash: created.contentHash,
    };
    const changes = diffMockDefinitions(undefined, definition);
    return v1Resource(ctx, saved(fields, changes, { created: true, dryRun: false }), 201);
  });
});

// POST /v1/projects/:projectId/mock-servers/:mockId/versions: save the next
// version from a whole definition or a merge patch, or with `dryRun` only
// report what the change would be.
mockServers.post("/projects/:projectId/mock-servers/:mockId/versions", async (c) => {
  const projectId = projectIdOf(c);
  const mockId = c.req.param("mockId") ?? "";
  const body = parseWithSchema(saveBody, await readJsonObjectBody(c));
  const head = await readMock(c, projectId, mockId);
  const before: MockDefinition = JSON.parse(head.definitionJson);
  // A patch is applied here so the change list and the checks run on exactly
  // what will be stored; the backend receives the whole result.
  const next = validatedDefinition(body.patch !== undefined ? applyMergePatch(before, body.patch) : body.definition);
  const changes = diffMockDefinitions(before, next);
  // A change equal to the head is let through: the backend answers it with the
  // head and `created: false`, which is what makes a retried save safe.
  if (body.expectedVersion !== head.headVersion && changes.length > 0) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      `The mock is at version ${head.headVersion}, not ${body.expectedVersion}. Read it again with get_mock_server, then apply your change to that version.`,
      { code: "MOCK_VERSION_STALE", headVersion: head.headVersion },
    );
  }
  const token = await getConvexBearerForRequest(c);
  return withReal(c, projectId, head.baseServerId, async (ctx, real) => {
    if (real) assertCallable(next, real);
    const fields = {
      id: head.mockId,
      name: head.name,
      projectId,
      baseServerId: head.baseServerId,
      version: head.headVersion,
      contentHash: head.contentHash,
    };
    if (body.dryRun) {
      // The version the save would write: the next one, or the head when the change equals it.
      const would = changes.length > 0;
      return v1Resource(
        ctx,
        saved(would ? { ...fields, version: head.headVersion + 1 } : fields, changes, { created: would, dryRun: true }),
      );
    }
    let result: { version: number; contentHash: string; created: boolean };
    try {
      result = await createConvexClient(token).mutation(fn.save, {
        mockId,
        definitionJson: JSON.stringify(next),
        expectedVersion: body.expectedVersion,
      });
    } catch (error) {
      throw translateMockWriteError(error);
    }
    const state = { created: result.created, dryRun: false };
    const stored = { ...fields, version: result.version, contentHash: result.contentHash };
    return v1Resource(ctx, saved(stored, changes, state), result.created ? 201 : 200);
  });
});

/** The real server for a read, or why it could not be read; a read never fails on it. */
async function readRealForGet(
  c: Context,
  projectId: string,
  row: MockRow,
  definition: MockDefinition,
): Promise<Pick<PlatformMockServer, "realServer" | "whatCanChange">> {
  if (!row.baseServerId) return { realServer: { status: "none", tools: [] } };
  try {
    const real = await runEphemeralConnection(
      c,
      { projectId, serverId: row.baseServerId },
      projectServerSchema,
      (manager, body) => listReal(manager, body.serverId, definition),
    );
    return {
      realServer: describeRealEdits(definition, real),
      // Every client a mock reaches, since no climb narrows it here.
      whatCanChange: whatCanChange({ server: real, clients: ALL_CLIENTS }),
    };
  } catch (error) {
    // The mock is readable without its real server. The cause stays in the
    // log: it can name the real server's address or its sign-in state.
    logger.warn("[v1.mock-servers] real server not read for get_mock_server", {
      mockId: row.mockId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      realServer: {
        status: "unreachable",
        message:
          "MCPJam could not read the real server just now. Check that it is up and that you can sign in to it, then read the mock again.",
        tools: [],
      },
    };
  }
}

/** The calls no saved answer matched. A list that cannot be read is empty: the mock reads without it. */
async function readUnmatched(token: string, mockId: string): Promise<PlatformMockUnmatchedCall[]> {
  try {
    return await createConvexClient(token).query(fn.unmatched, { mockId });
  } catch (error) {
    logger.warn("[v1.mock-servers] unmatched calls not read for get_mock_server", {
      mockId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// GET /v1/projects/:projectId/mock-servers/:mockId?version=&since=
mockServers.get("/projects/:projectId/mock-servers/:mockId", async (c) => {
  const projectId = projectIdOf(c);
  const mockId = c.req.param("mockId") ?? "";
  const { version, since } = parseWithSchema(versionQuery, c.req.query());
  const row = await readMock(c, projectId, mockId, version);
  const definition: MockDefinition = JSON.parse(row.definitionJson);
  const earlier = since === undefined ? undefined : await readMock(c, projectId, mockId, since);
  const dto: PlatformMockServer = {
    id: row.mockId,
    name: row.name,
    projectId,
    baseServerId: row.baseServerId,
    address: mockServerAddress(row.mockId),
    version: row.version,
    headVersion: row.headVersion,
    contentHash: row.contentHash,
    definition,
    createdAt: row.createdAt ?? null,
    ...(earlier
      ? { sinceVersion: earlier.version, changes: diffMockDefinitions(JSON.parse(earlier.definitionJson), definition) }
      : {}),
    unmatchedCalls: await readUnmatched(await getConvexBearerForRequest(c), row.mockId),
    ...(await readRealForGet(c, projectId, row, definition)),
  };
  return v1Resource(c, dto);
});

export default mockServers;
