import type {
  GetPromptResult,
  ListPromptsResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ReadResourceResult,
  Server,
  ServerCapabilities,
} from "@modelcontextprotocol/server";
import {
  MCP_SKILLS_EXTENSION_ID,
  isSkillNotFoundError,
} from "../mcp-client-manager/index.js";
import type { SkillEntry } from "../mcp-client-manager/index.js";
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
  resolveMockTemplates,
} from "./resolve-items.js";
import {
  SKILLS_CACHE_SCOPE,
  SKILLS_SETTINGS_TTL_MS,
  adjustMockSkill,
  definitionTouchesSkills,
  listMockSkills,
  skillNotFoundError,
} from "./mock-skills.js";

/** What the handlers need about both sides of the mock. */
export interface ItemHandlerContext {
  definition: MockDefinition;
  real: MockRealServer;
  /** What the real server declared. */
  realCapabilities: ServerCapabilities;
  /** What the mock declares after the definition's edits. */
  mockCapabilities: ServerCapabilities;
}

type Obj = Record<string, unknown>;

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

  if (
    mockCapabilities.resources &&
    (hasEntries(definition.resources) ||
      hasEntries(definition.resourceTemplates))
  ) {
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
    server.setRequestHandler(
      "resources/templates/list",
      async (request, ctx) => {
        const realTemplates = realCapabilities.resources
          ? await realPages<
              ListResourceTemplatesResult["resourceTemplates"][number]
            >(
              real,
              "resources/templates/list",
              "resourceTemplates",
              ctx.mcpReq.signal
            )
          : [];
        const { items, missing } = resolveMockTemplates(
          definition,
          realTemplates
        );
        if (missing.length > 0)
          throw editedItemMissingError("resource template", missing);
        const page = pageOf(items, request.params?.cursor, pageSize);
        return {
          resourceTemplates: page.items,
          ...(page.nextCursor && { nextCursor: page.nextCursor }),
        };
      }
    );
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

const SKILL_METHODS = ["skills/list", "skills/get"];

/**
 * `skills/list` and `skills/get` for a mock whose definition has skill files.
 * Returns `undefined` for any other method or when there is nothing to say
 * about skills, so the caller passes the method to the real server instead.
 */
export async function answerSkillsMethod(
  request: { method: string; params?: Obj },
  c: ItemHandlerContext,
  signal: AbortSignal | undefined
): Promise<Obj | undefined> {
  const { definition, real, realCapabilities, mockCapabilities } = c;
  if (
    !SKILL_METHODS.includes(request.method) ||
    !definitionTouchesSkills(definition) ||
    !mockCapabilities.extensions?.[MCP_SKILLS_EXTENSION_ID]
  ) {
    return undefined;
  }
  const realHasSkills = Boolean(
    realCapabilities.extensions?.[MCP_SKILLS_EXTENSION_ID]
  );
  const cache = {
    ttlMs: SKILLS_SETTINGS_TTL_MS,
    cacheScope: SKILLS_CACHE_SCOPE,
  };
  if (request.method === "skills/list") {
    const realSkills = realHasSkills
      ? await realPages<SkillEntry>(real, "skills/list", "skills", signal)
      : [];
    const skills = await listMockSkills(definition, realSkills);
    const page = pageOf(
      skills,
      request.params?.cursor as string | undefined,
      definition.pageSize
    );
    return {
      skills: page.items,
      ...(page.nextCursor && { nextCursor: page.nextCursor }),
      ...cache,
    };
  }
  const uri = String(request.params?.uri ?? "");
  const realSkills = realHasSkills
    ? await realPages<SkillEntry>(real, "skills/list", "skills", signal)
    : [];
  const listed = (await listMockSkills(definition, realSkills)).find(
    (s) => s.uri === uri
  );
  if (listed) return { skill: listed, ...cache };
  // A skill the real server serves but never listed: ask it, and adjust what it says.
  if (realHasSkills) {
    try {
      const found = (await real.request(
        { method: "skills/get", params: { uri } },
        { signal }
      )) as {
        skill?: SkillEntry;
      };
      const adjusted = found.skill
        ? await adjustMockSkill(definition, found.skill)
        : undefined;
      if (adjusted) return { skill: adjusted, ...cache };
    } catch (error) {
      // A skill the real server does not serve is not found here either; any
      // other failure is the real server's and reaches the caller.
      if (!isSkillNotFoundError(error)) throw error;
    }
  }
  throw skillNotFoundError(uri);
}
