/**
 * Public `/api/v1` mock servers: create one, save its next version, read one,
 * and read or set the forwarding policy. The definition is checked here, with
 * the SDK's validator, before the backend stores it: the checks need Node-only
 * code, and the route gives every surface the same refusals. The tiers and the
 * `mock-servers-enabled` flag are the backend's, called with the caller's own
 * bearer.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { PlatformMockForwardingPolicy, PlatformMockLoosened } from "@mcpjam/sdk/platform";
import { parseWithSchema } from "../web/errors.js";
import { logger } from "../../utils/logger.js";
import { readJsonObjectBody } from "./adapter.js";
import { requireProjectIdArg } from "./convex-id-param.js";
import { v1Resource } from "./envelope.js";
import { bearerOf, createConvexClient, fn, readMock, readRealServer, saved } from "./mock-server-io.js";
import { patchBody, patchMock, refreshBody, refreshMock } from "./mock-server-edits.js";
import { readMockPage, readQuery, writeSummary } from "./mock-server-reads.js";
import { readMockPolicy, readProjectPolicy, writeProjectPolicy } from "./mock-policy-backend.js";
import {
  applyMergePatch,
  assertCallable,
  discoveryOf,
  savedTools,
  translateMockWriteError,
  validatedDefinition,
} from "./mock-server-support.js";

const mockServers = new Hono();

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
  })
  .refine((body) => (body.definition === undefined) !== (body.patch === undefined), {
    message: "Give exactly one of `definition` and `patch`.",
  });
const policyBody = z.strictObject({ forwarding: z.enum(["allow", "block"]) });

function projectIdOf(c: Context): string {
  const projectId = c.req.param("projectId") ?? "";
  requireProjectIdArg(projectId, "v1.mock-servers");
  return projectId;
}

/** A policy read or write, with the backend's refusals as public errors. */
async function policyOf<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translateMockWriteError(error);
  }
}

// POST /v1/projects/:projectId/mock-servers: create a mock, version 1.
mockServers.post("/projects/:projectId/mock-servers", async (c) => {
  const projectId = projectIdOf(c);
  const body = parseWithSchema(createBody, await readJsonObjectBody(c));
  // The caller is settled before the definition is checked: the checks run the
  // definition's own patterns, and the v1 gateway does not verify an AuthKit
  // token itself. The backend's project read verifies it and checks access and
  // the flag. A save or patch gets the same order by reading the mock first.
  await policyOf(async () => readProjectPolicy(await bearerOf(c), projectId));
  const definition = validatedDefinition(body.definition);
  // The base's listing is captured now and saved with the version, so a mock
  // can list it later while forwarding is blocked, without contacting the base.
  const real = body.serverId ? await readRealServer(c, projectId, body.serverId) : undefined;
  const discoveryJson = real ? discoveryOf(real) : undefined;
  assertCallable(definition, real?.tools);
  let created: { mockId: string; version: number; contentHash: string; created: boolean; loosened?: PlatformMockLoosened[] };
  try {
    created = await createConvexClient(await bearerOf(c)).mutation(fn.create, {
      projectId,
      ...(body.serverId ? { baseServerId: body.serverId } : {}),
      name: body.name,
      definitionJson: JSON.stringify(definition),
      ...(discoveryJson ? { discoveryJson } : {}),
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
  const policy = await policyOf(async () => readMockPolicy(await bearerOf(c), created.mockId));
  const written = { ...saved(fields, created), policy };
  const summary = await writeSummary(c, created.mockId, created.version, definition, written);
  return v1Resource(c, { ...written, ...summary }, created.created ? 201 : 200);
});

// POST /v1/projects/:projectId/mock-servers/:mockId/versions: save the next
// version from a whole definition or a merge patch against `expectedVersion`.
// A save equal to the head answers the head (`created: false`): that is what
// makes a retry of a save that landed safe. A stale one answers 409 with the head.
mockServers.post("/projects/:projectId/mock-servers/:mockId/versions", async (c) => {
  const projectId = projectIdOf(c);
  const mockId = c.req.param("mockId") ?? "";
  const body = parseWithSchema(saveBody, await readJsonObjectBody(c));
  const head = await readMock(c, projectId, mockId);
  // A patch is applied here so the checks run on exactly what will be stored;
  // the backend merges the same patch against its own head.
  const definition = validatedDefinition(
    body.patch !== undefined ? applyMergePatch(JSON.parse(head.definitionJson), body.patch) : body.definition,
  );
  // A stale save stores nothing: the backend answers it with a 409, or with the
  // head when it equals the head (a retry of a save that landed). It needs no
  // check of callability, and its caller learns of the newer head first.
  if (body.expectedVersion === head.headVersion) {
    assertCallable(definition, savedTools(head.discovery?.listingJson));
  }
  let result: { version: number; contentHash: string; created: boolean; loosened?: PlatformMockLoosened[] };
  try {
    result = await createConvexClient(await bearerOf(c)).mutation(fn.save, {
      mockId,
      expectedVersion: body.expectedVersion,
      ...(body.patch !== undefined
        ? { patchJson: JSON.stringify(body.patch) }
        : { definitionJson: JSON.stringify(body.definition) }),
    });
  } catch (error) {
    throw translateMockWriteError(error);
  }
  const fields = {
    id: head.mockId,
    name: head.name,
    projectId,
    baseServerId: head.baseServerId,
    version: result.version,
    contentHash: result.contentHash,
  };
  const policy = await policyOf(async () => readMockPolicy(await bearerOf(c), head.mockId));
  const written = { ...saved(fields, result), policy };
  const summary = await writeSummary(c, head.mockId, result.version, definition, written);
  return v1Resource(c, { ...written, ...summary }, result.created ? 201 : 200);
});

// GET /v1/projects/:projectId/mock-servers/:mockId: a bounded read. With no
// selector the summary; `family` lists names, `family` and `name` read one
// entry, `path` one field, and `cursor` continues a page.
mockServers.get("/projects/:projectId/mock-servers/:mockId", async (c) => {
  const projectId = projectIdOf(c);
  const mockId = c.req.param("mockId") ?? "";
  return v1Resource(c, await readMockPage(c, projectId, mockId, parseWithSchema(readQuery, c.req.query())));
});

// PATCH /v1/projects/:projectId/mock-servers/:mockId: set or remove one path,
// against `expectedVersion`.
mockServers.patch("/projects/:projectId/mock-servers/:mockId", async (c) => {
  const projectId = projectIdOf(c);
  const body = parseWithSchema(patchBody, await readJsonObjectBody(c));
  const { result, status } = await patchMock(c, projectId, c.req.param("mockId") ?? "", body);
  return v1Resource(c, result, status);
});

// POST /v1/projects/:projectId/mock-servers/:mockId/refresh: preview the real
// server's changes since the saved listing, and save them when `apply` is set.
mockServers.post("/projects/:projectId/mock-servers/:mockId/refresh", async (c) => {
  const projectId = projectIdOf(c);
  const body = parseWithSchema(refreshBody, await readJsonObjectBody(c));
  const result = await refreshMock(c, projectId, c.req.param("mockId") ?? "", body);
  return v1Resource(c, result, result.applied ? 201 : 200);
});

// GET /v1/projects/:projectId/mock-servers/:mockId/forwarding-policy: the
// policy in force for this mock.
mockServers.get("/projects/:projectId/mock-servers/:mockId/forwarding-policy", async (c) => {
  const projectId = projectIdOf(c);
  const mockId = c.req.param("mockId") ?? "";
  await readMock(c, projectId, mockId);
  const policy = await policyOf(async () => readMockPolicy(await bearerOf(c), mockId));
  const dto: PlatformMockForwardingPolicy = { ...policy, projectId, mockId };
  return v1Resource(c, dto);
});

// GET /v1/projects/:projectId/mock-forwarding-policy: the workspace's setting.
mockServers.get("/projects/:projectId/mock-forwarding-policy", async (c) => {
  const projectId = projectIdOf(c);
  const policy = await policyOf(async () => readProjectPolicy(await bearerOf(c), projectId));
  const dto: PlatformMockForwardingPolicy = { ...policy, projectId };
  return v1Resource(c, dto);
});

// PUT /v1/projects/:projectId/mock-forwarding-policy: admins only (the backend decides).
mockServers.put("/projects/:projectId/mock-forwarding-policy", async (c) => {
  const projectId = projectIdOf(c);
  const body = parseWithSchema(policyBody, await readJsonObjectBody(c));
  const policy = await policyOf(async () =>
    writeProjectPolicy(await bearerOf(c), projectId, body.forwarding),
  );
  logger.info("[v1.mock-servers] forwarding policy set", { projectId, forwarding: body.forwarding });
  const dto: PlatformMockForwardingPolicy = { ...policy, projectId };
  return v1Resource(c, dto);
});

export default mockServers;
