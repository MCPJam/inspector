/**
 * Two authoring operations that read first and then save: a patch of exactly
 * one path, and a refresh of the saved listing from the real server. Each
 * saves against `expectedVersion`; the backend still decides atomically, so a
 * head that moves between the read here and the save is refused there.
 */
import type { Context } from "hono";
import { z } from "zod";
import { canonicalJson } from "@mcpjam/sdk/contract";
import {
  MOCK_FAMILIES,
  applyFieldEdit,
  findBindingIssues,
  type MockDefinition,
  type MockFamily,
  type MockListing,
} from "@mcpjam/sdk/mocks";
import type {
  PlatformMockLoosened,
  PlatformMockPatched,
  PlatformMockRefresh,
} from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { bearerOf, createConvexClient, fn, readMock, readRealServer, saved, staleHead } from "./mock-server-io.js";
import { assertCallable, discoveryOf, savedTools, translateMockWriteError, validatedDefinition } from "./mock-server-support.js";

export const patchBody = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    family: z.enum(MOCK_FAMILIES).optional(),
    name: z.string().trim().min(1).optional(),
    path: z.array(z.string().min(1)).optional(),
    value: z.unknown().optional(),
    remove: z.boolean().optional(),
  });

export const refreshBody = z.strictObject({
  expectedVersion: z.number().int().min(1),
  apply: z.boolean().optional(),
});

type SaveResult = { version: number; contentHash: string; created: boolean; loosened?: PlatformMockLoosened[] };

export async function patchMock(
  c: Context,
  projectId: string,
  mockId: string,
  body: z.infer<typeof patchBody>
): Promise<{ result: PlatformMockPatched; status: 200 | 201 }> {
  const head = await readMock(c, projectId, mockId);
  const current: MockDefinition = JSON.parse(head.definitionJson);
  const { expectedVersion, ...edit } = body;
  const applied = applyFieldEdit(current, edit);
  if (!applied.ok) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, applied.message, { code: "MOCK_EDIT_INVALID" });
  }
  const fields = {
    id: head.mockId,
    name: head.name,
    projectId,
    baseServerId: head.baseServerId,
  };
  // The same edit on a head that already holds it is a retry of a patch that
  // landed: answer the head, as the backend does for an identical save.
  if (canonicalJson(applied.definition) === canonicalJson(current)) {
    const result = saved({ ...fields, version: head.headVersion, contentHash: head.contentHash }, { created: false, loosened: head.loosened });
    return { result: { ...result, path: applied.path }, status: 200 };
  }
  if (head.headVersion !== expectedVersion) throw staleHead(head.headVersion);
  assertCallable(validatedDefinition(applied.definition), savedTools(head.discovery?.listingJson));
  let result: SaveResult;
  try {
    result = await createConvexClient(await bearerOf(c)).mutation(fn.save, {
      mockId,
      expectedVersion,
      definitionJson: JSON.stringify(applied.definition),
    });
  } catch (error) {
    throw translateMockWriteError(error);
  }
  const out = saved({ ...fields, version: result.version, contentHash: result.contentHash }, result);
  return { result: { ...out, path: applied.path }, status: result.created ? 201 : 200 };
}

const FAMILY_KEY: Record<MockFamily, string> = {
  tools: "name",
  prompts: "name",
  resources: "uri",
  resourceTemplates: "uriTemplate",
};
/** Names listed per bucket; the rest are counted in `more`. */
const MAX_NAMES = 25;

function differences(before: MockListing | undefined, after: MockListing): PlatformMockRefresh["differences"] {
  const out: PlatformMockRefresh["differences"] = [];
  for (const family of MOCK_FAMILIES) {
    const key = FAMILY_KEY[family];
    const index = (list: unknown) =>
      new Map(((list ?? []) as Record<string, unknown>[]).map((entry) => [String(entry[key]), canonicalJson(entry)]));
    const was = index(before?.[family]);
    const now = index(after[family]);
    const added = [...now.keys()].filter((name) => !was.has(name));
    const removed = [...was.keys()].filter((name) => !now.has(name));
    const changed = [...now].filter(([name, text]) => was.has(name) && was.get(name) !== text).map(([name]) => name);
    if (added.length + removed.length + changed.length === 0) continue;
    out.push({
      family,
      added: added.slice(0, MAX_NAMES),
      removed: removed.slice(0, MAX_NAMES),
      changed: changed.slice(0, MAX_NAMES),
      more: Math.max(0, added.length - MAX_NAMES) + Math.max(0, removed.length - MAX_NAMES) + Math.max(0, changed.length - MAX_NAMES),
    });
  }
  return out;
}

export async function refreshMock(
  c: Context,
  projectId: string,
  mockId: string,
  body: z.infer<typeof refreshBody>
): Promise<PlatformMockRefresh> {
  const head = await readMock(c, projectId, mockId);
  if (head.headVersion !== body.expectedVersion) throw staleHead(head.headVersion);
  if (!head.baseServerId) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "This mock has no real server to refresh from. Make a mock of a saved server to refresh it.", { code: "MOCK_NO_BASE" });
  }
  // As the caller: what they may read of the base is what the preview shows.
  const live = await readRealServer(c, projectId, head.baseServerId);
  const definition: MockDefinition = JSON.parse(head.definitionJson);
  const before: MockListing | undefined = head.discovery ? JSON.parse(head.discovery.listingJson) : undefined;
  const broken = findBindingIssues(definition, live.tools);
  const preview: PlatformMockRefresh = {
    view: "refresh",
    id: head.mockId,
    mockName: head.name,
    projectId,
    version: head.version,
    headVersion: head.headVersion,
    contentHash: head.contentHash,
    listing: head.discovery ? "saved" : head.hasDiscovery ? "private" : "none",
    applied: false,
    differences: differences(before, { tools: live.tools, prompts: live.prompts, resources: live.resources, resourceTemplates: live.resourceTemplates }),
    brokenOverrides: broken.slice(0, MAX_NAMES),
    brokenTotal: broken.length,
  };
  if (!body.apply) return preview;
  const discoveryJson = discoveryOf(live);
  if (!discoveryJson) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "The real server's listing is too large to save with a version. Nothing was saved.", { code: "MOCK_DISCOVERY_TOO_LARGE" });
  }
  let result: SaveResult;
  try {
    // An empty merge patch changes no definition; the new listing is the change.
    result = await createConvexClient(await bearerOf(c)).mutation(fn.save, {
      mockId,
      expectedVersion: body.expectedVersion,
      patchJson: "{}",
      discoveryJson,
    });
  } catch (error) {
    throw translateMockWriteError(error);
  }
  const fields = { id: head.mockId, name: head.name, projectId, baseServerId: head.baseServerId, version: result.version, contentHash: result.contentHash };
  return { ...preview, applied: true, version: result.version, headVersion: result.version, contentHash: result.contentHash, saved: saved(fields, result) };
}
