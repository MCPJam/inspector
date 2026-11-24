import type {
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ReadResourceResult,
  Server,
  ServerCapabilities,
} from "@modelcontextprotocol/server";
import type { MockDefinition } from "./definition-types.js";
import {
  editedItemMissingError,
  promptNotFoundError,
  resourceNotFoundError,
} from "./mock-errors.js";
import type { MockRealServer } from "./real-server.js";
import { pageOf } from "./paging.js";
import {
  planPromptGet,
  planResourceRead,
  resolveMockPrompts,
  resolveMockResources,
} from "./resolve-items.js";
/** What the handlers need about both sides of the mock. */
export interface ItemHandlerContext {
  definition: MockDefinition;
  real: MockRealServer;
  /** What the real server declared. */
  realCapabilities: ServerCapabilities;
  /** What the mock declares after the definition's edits. */
  mockCapabilities: ServerCapabilities;
}

/** Every page of one of the real server's lists. */
async function realPages<T>(
  real: MockRealServer,
  method: string,
  key: string,
  signal: AbortSignal | undefined
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await real.request(
      { method, params: cursor === undefined ? {} : { cursor } },
      { signal }
    );
    items.push(...((page[key] as T[] | undefined) ?? []));
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor);
  return items;
}

const hasEntries = (map: object | undefined) =>
  map !== undefined && Object.keys(map).length > 0;

/**
 * Registers the handlers for the lists the definition edits. A family the
 * definition leaves alone is not registered, so its methods keep going to the
 * real server as before (and are refused by name when one side lacks it).
 */
export function registerItemHandlers(
  server: Server,
  c: ItemHandlerContext
): void {
  const { definition, real, realCapabilities, mockCapabilities } = c;
  const pageSize = definition.pageSize;

  if (mockCapabilities.prompts && hasEntries(definition.prompts)) {
    server.setRequestHandler("prompts/list", async (request, ctx) => {
      const realPrompts = realCapabilities.prompts
        ? await realPages<ListPromptsResult["prompts"][number]>(
            real,
            "prompts/list",
            "prompts",
            ctx.mcpReq.signal
          )
        : [];
      const { items, missing } = resolveMockPrompts(definition, realPrompts);
      if (missing.length > 0) throw editedItemMissingError("prompt", missing);
      const page = pageOf(items, request.params?.cursor, pageSize);
      return {
        prompts: page.items,
        ...(page.nextCursor && { nextCursor: page.nextCursor }),
      };
    });
    server.setRequestHandler("prompts/get", async (request, ctx) => {
      const { name } = request.params;
      const plan = planPromptGet(definition, name, request.params.arguments);
      if (plan.kind === "own") return plan.result;
      if (plan.kind === "hidden" || !realCapabilities.prompts)
        throw promptNotFoundError(name);
      return (await real.request(
        { method: "prompts/get", params: request.params },
        { signal: ctx.mcpReq.signal }
      )) as GetPromptResult;
    });
  }

  if (mockCapabilities.resources && hasEntries(definition.resources)) {
    server.setRequestHandler("resources/list", async (request, ctx) => {
      const realResources = realCapabilities.resources
        ? await realPages<ListResourcesResult["resources"][number]>(
            real,
            "resources/list",
            "resources",
            ctx.mcpReq.signal
          )
        : [];
      const { items, missing } = resolveMockResources(
        definition,
        realResources
      );
      if (missing.length > 0) throw editedItemMissingError("resource", missing);
      const page = pageOf(items, request.params?.cursor, pageSize);
      return {
        resources: page.items,
        ...(page.nextCursor && { nextCursor: page.nextCursor }),
      };
    });
    server.setRequestHandler("resources/read", async (request, ctx) => {
      const { uri } = request.params;
      const plan = planResourceRead(definition, uri);
      if (plan.kind === "own") return plan.result;
      if (plan.kind === "hidden" || !realCapabilities.resources)
        throw resourceNotFoundError(uri);
      return (await real.request(
        { method: "resources/read", params: request.params },
        { signal: ctx.mcpReq.signal }
      )) as ReadResourceResult;
    });
  }
}
