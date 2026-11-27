/**
 * The bounded reads of one mock: the default summary, a page of names, one
 * entry, and one field or nested path. The page sizes and chunking are the
 * SDK's (`@mcpjam/sdk/mocks`); this module binds cursors to the caller and
 * reads the version a cursor started on, so a head edit during paging cannot
 * change what the next page shows.
 */
import type { Context } from "hono";
import { z } from "zod";
import {
  MockCursorError,
  changeEntries,
  fitPage,
  openMockCursor,
  readMockView,
  readSelectorProblem,
  sealMockCursor,
  type MockDefinition,
  type MockListing,
  type MockReadSelector,
} from "@mcpjam/sdk/mocks";
import type { PlatformMockListingState } from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { mockServerAddress } from "../../services/mock/address.js";
import { bearerOf, readMock, type MockRow } from "./mock-server-io.js";
import { readMockPolicy } from "./mock-policy-backend.js";
import { countsOf, translateMockWriteError } from "./mock-server-support.js";

export const readQuery = z.object({
  version: z.coerce.number().int().min(1).optional(),
  family: z.enum(["tools", "prompts", "resources", "resourceTemplates"]).optional(),
  name: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});
type ReadQuery = z.infer<typeof readQuery>;

const refuse = (message: string, extra: Record<string, unknown> = {}) =>
  new WebRouteError(400, ErrorCode.VALIDATION_ERROR, message, extra);

/** A path as a list of keys: dotted, or a JSON list when a key has a dot in it. */
function pathOf(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!raw.startsWith("[")) return raw.split(".");
  const notAList = () =>
    refuse('`path` starts with "[" but is not a JSON list of keys. Send keys like ["inputSchema","properties"] or a dotted path.');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((key) => typeof key === "string" && key !== "")) return parsed;
  } catch {
    throw notAList();
  }
  throw notAList();
}

/** The caller and the mock a cursor is issued to. */
function scopeOf(c: Context, mockId: string, fallback: string): string {
  const caller = c.get("workosUserId") ?? c.get("guestId") ?? fallback;
  return `${String(caller)}|${String(c.get("mcpjamOrganizationId") ?? "")}|${mockId}`;
}

function listingOf(row: MockRow): { listing?: MockListing; state: PlatformMockListingState } {
  if (row.discovery) {
    return { listing: JSON.parse(row.discovery.listingJson) as MockListing, state: "saved" };
  }
  return { state: row.hasDiscovery ? "private" : "none" };
}

/**
 * The counts and the first bounded page of changes a create or a save answers
 * with. The cursor it issues is the default read's own, bound to the caller and
 * to the version just saved, so a read continues the list from it.
 */
export async function writeSummary(
  c: Context,
  mockId: string,
  version: number,
  definition: MockDefinition,
  envelope: Record<string, unknown>
) {
  const binding = {
    scope: scopeOf(c, mockId, await bearerOf(c)),
    query: { family: undefined, name: undefined, path: undefined, search: undefined },
  };
  const seal = (next: number) => sealMockCursor({ version, offset: next }, binding);
  const changes = fitPage(changeEntries(definition), { offset: 0, seal, envelope }, undefined, (items, page) => ({
    changes: { items, page },
  }));
  return { counts: countsOf(definition), ...changes };
}

export async function readMockPage(
  c: Context,
  projectId: string,
  mockId: string,
  query: ReadQuery
): Promise<Record<string, unknown>> {
  const path = pathOf(query.path);
  const selector: MockReadSelector = {
    ...(query.family && { family: query.family }),
    ...(query.name && { name: query.name }),
    ...(path && { path }),
    ...(query.search && { search: query.search }),
    ...(query.limit && { limit: query.limit }),
  };
  const problem = readSelectorProblem(selector);
  if (problem) throw refuse(problem, { code: "MOCK_READ_INVALID" });

  const token = await bearerOf(c);
  const binding = {
    scope: scopeOf(c, mockId, token),
    query: { family: query.family, name: query.name, path, search: query.search },
  };
  let version = query.version;
  let offset = 0;
  if (query.cursor) {
    try {
      const state = openMockCursor(query.cursor, binding);
      if (version !== undefined && version !== state.version) {
        throw new MockCursorError("other_query", `That cursor continues version ${state.version}, not version ${version}. Drop \`version\` or read again without a cursor.`);
      }
      ({ version, offset } = state);
    } catch (error) {
      if (error instanceof MockCursorError) {
        throw refuse(error.message, { code: "MOCK_CURSOR_REFUSED", reason: error.reason });
      }
      throw error;
    }
  }

  const row = await readMock(c, projectId, mockId, version);
  const definition: MockDefinition = JSON.parse(row.definitionJson);
  const { listing, state } = listingOf(row);
  const seal = (next: number) => sealMockCursor({ version: row.version, offset: next }, binding);
  try {
    if (!query.family && !path) {
      const envelope = {
        view: "summary" as const,
        id: row.mockId,
        name: row.name,
        projectId,
        baseServerId: row.baseServerId,
        address: mockServerAddress(row.mockId),
        version: row.version,
        headVersion: row.headVersion,
        contentHash: row.contentHash,
        loosened: row.loosened ?? [],
        policy: await readPolicy(token, row.mockId),
        counts: countsOf(definition),
        createdAt: row.createdAt ?? null,
      };
      const changes = fitPage(changeEntries(definition), { offset, seal, envelope }, query.limit, (items, page) => ({
        changes: { items, page },
      }));
      return { ...envelope, ...changes };
    }
    const envelope = {
      id: row.mockId,
      mockName: row.name,
      projectId,
      version: row.version,
      headVersion: row.headVersion,
      contentHash: row.contentHash,
      listing: state,
    };
    const paged = readMockView({ definition, listing }, selector, { offset, seal, envelope });
    if (!paged) {
      const what = path ? `path "${path.join(".")}"` : `${query.family} "${query.name}"`;
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, `This mock has no ${what}. List the family with \`search\` to find the name.`);
    }
    return { ...envelope, ...paged };
  } catch (error) {
    if (error instanceof MockCursorError) {
      throw refuse(error.message, { code: "MOCK_CURSOR_REFUSED", reason: error.reason });
    }
    throw error;
  }
}

async function readPolicy(token: string, mockId: string) {
  try {
    return await readMockPolicy(token, mockId);
  } catch (error) {
    throw translateMockWriteError(error);
  }
}
