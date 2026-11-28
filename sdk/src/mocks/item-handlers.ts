import type {
  GetPromptResult,
  Prompt,
  Resource,
  ResourceTemplateType as ResourceTemplate,
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
  isRealUnreachable,
  promptNotFoundError,
  resourceNotFoundError,
} from "./mock-errors.js";
import type { MockItemKind } from "./mock-errors.js";
import type { MockListingFamily, MockRealServer } from "./real-server.js";
import { pageOf } from "./paging.js";
import {
  planPromptGet,
  planResourceRead,
  resolveMockPrompts,
  resolveMockResources,
  resolveMockTemplates,
} from "./resolve-items.js";
import type { ResolvedItems } from "./resolve-items.js";
import {
  SKILLS_CACHE_SCOPE,
  SKILLS_SETTINGS_TTL_MS,
  adjustMockSkill,
  definitionTouchesSkills,
  listMockSkills,
  skillNotFoundError,
} from "./mock-skills.js";
import { forRevision } from "./legacy-result.js";
import { assertRequestForward, decideForward } from "./tool-handlers.js";

/** What the handlers need about both sides of the mock. */
export interface ItemHandlerContext {
  definition: MockDefinition;
  real: MockRealServer;
  /** What the real server declared. */
  realCapabilities: ServerCapabilities;
  /** What the mock declares after the definition's edits. */
  mockCapabilities: ServerCapabilities;
  /** The revision this request is served under; a forwarded result is shown as that revision's. */
  revision?: string;
}

type Obj = Record<string, unknown>;

/**
 * One request to the real server, after the host allows it. Every read of an
 * item the definition does not state goes through here, so a blocked policy or
 * a caller without access stops it before anything is dispatched.
 */
export async function forwardToReal(
  c: ItemHandlerContext,
  method: string,
  params: Obj | undefined,
  signal: AbortSignal
): Promise<Obj> {
  await assertRequestForward(c, method, signal);
  const result = await c.real.request({ method, params }, { signal });
  return c.revision ? forRevision(result, c.revision) : result;
}

interface RealItems<T> {
  items: T[];
  /** How many entries the real server puts on a page, when it pages; else `undefined`. */
  pageSize?: number;
}

/**
 * Every page of one of the real server's lists, each page asked for after the
 * host allows it. With a `family`, a list the host does not allow to be read
 * is served from the version's pinned listing instead (the same rule tools
 * follow), so a blocked mock still lists what it was saved with. A mock with no
 * base (`no_base`) has nothing pinned and keeps its own refusal.
 */
async function realPages<T>(
  c: ItemHandlerContext,
  method: string,
  key: string,
  signal: AbortSignal,
  family?: MockListingFamily
): Promise<RealItems<T>> {
  if (family && c.real.pinnedListing) {
    const decision = await decideForward(c, { kind: "request", method }, signal);
    if (!decision.allowed && decision.reason !== "no_base") {
      return { items: (await c.real.pinnedListing(family)) as T[] };
    }
  }
  const items: T[] = [];
  let pageSize: number | undefined;
  let cursor: string | undefined;
  try {
    do {
      const page = await forwardToReal(
        c,
        method,
        cursor === undefined ? {} : { cursor },
        signal
      );
      const entries = (page[key] as T[] | undefined) ?? [];
      items.push(...entries);
      cursor =
        typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      // A list that continues shows the real server's page size.
      if (cursor !== undefined) pageSize ??= entries.length || undefined;
    } while (cursor);
  } catch (error) {
    // The base is down: the saved listing keeps the mock's own entries
    // available, as it does while forwarding is blocked.
    if (family && c.real.pinnedListing && isRealUnreachable(error)) {
      return { items: (await c.real.pinnedListing(family)) as T[] };
    }
    throw error;
  }
  return { items, pageSize };
}

const hasEntries = (map: object | undefined) =>
  map !== undefined && Object.keys(map).length > 0;

interface ListSpec<T, K extends string> {
  method: string;
  /** The field of the result that holds the entries. */
  field: K;
  kind: MockItemKind;
  realHas: boolean;
  /** The pinned family that stands in for the real list while forwarding is blocked. */
  family: MockListingFamily;
  resolve: (real: T[]) => ResolvedItems<T>;
}

/**
 * One page of a list the definition edits. The real server's entries are all
 * read (an edit to something it dropped must be found), the definition laid
 * over them, and the result cut into pages the size the real server used; a
 * `pageSize` in the definition overrides that, and a list made from nothing
 * has no real pages, so it follows `pageSize` alone.
 */
async function listPage<T, K extends string>(
  c: ItemHandlerContext,
  spec: ListSpec<T, K>,
  cursor: string | undefined,
  signal: AbortSignal
): Promise<Record<K, T[]> & { nextCursor?: string }> {
  const real: RealItems<T> = spec.realHas
    ? await realPages<T>(c, spec.method, spec.field, signal, spec.family)
    : { items: [] };
  const { items, missing } = spec.resolve(real.items);
  if (missing.length > 0) throw editedItemMissingError(spec.kind, missing);
  const page = pageOf(items, cursor, c.definition.pageSize ?? real.pageSize);
  // The computed key is `string` to the compiler; `K` is the field the caller named.
  return {
    [spec.field]: page.items,
    ...(page.nextCursor && { nextCursor: page.nextCursor }),
  } as Record<K, T[]> & { nextCursor?: string };
}

/**
 * Registers the handlers for the lists the definition edits. A family the
 * definition leaves alone is not registered, so its methods keep going to the
 * real server as before (and are refused by name when one side lacks it).
 */
export function registerItemHandlers(
  server: Server,
  c: ItemHandlerContext
): void {
  const { definition, realCapabilities, mockCapabilities } = c;

  if (mockCapabilities.prompts && hasEntries(definition.prompts)) {
    server.setRequestHandler("prompts/list", async (request, ctx) =>
      listPage<Prompt, "prompts">(
        c,
        {
          method: "prompts/list",
          field: "prompts",
          kind: "prompt",
          realHas: Boolean(realCapabilities.prompts),
          family: "prompts",
          resolve: (real) => resolveMockPrompts(definition, real),
        },
        request.params?.cursor,
        ctx.mcpReq.signal
      )
    );
    server.setRequestHandler("prompts/get", async (request, ctx) => {
      const { name } = request.params;
      const plan = planPromptGet(definition, name, request.params.arguments);
      if (plan.kind === "own") return plan.result;
      if (plan.kind === "hidden" || !realCapabilities.prompts)
        throw promptNotFoundError(name);
      return (await forwardToReal(
        c,
        "prompts/get",
        request.params,
        ctx.mcpReq.signal
      )) as GetPromptResult;
    });
  }

  if (
    mockCapabilities.resources &&
    (hasEntries(definition.resources) ||
      hasEntries(definition.resourceTemplates))
  ) {
    const realHas = Boolean(realCapabilities.resources);
    server.setRequestHandler("resources/list", async (request, ctx) =>
      listPage<Resource, "resources">(
        c,
        {
          method: "resources/list",
          field: "resources",
          kind: "resource",
          realHas,
          family: "resources",
          resolve: (real) => resolveMockResources(definition, real),
        },
        request.params?.cursor,
        ctx.mcpReq.signal
      )
    );
    server.setRequestHandler("resources/templates/list", async (request, ctx) =>
      listPage<ResourceTemplate, "resourceTemplates">(
        c,
        {
          method: "resources/templates/list",
          field: "resourceTemplates",
          kind: "resource template",
          realHas,
          family: "resourceTemplates",
          resolve: (real) => resolveMockTemplates(definition, real),
        },
        request.params?.cursor,
        ctx.mcpReq.signal
      )
    );
    server.setRequestHandler("resources/read", async (request, ctx) => {
      const { uri } = request.params;
      const plan = planResourceRead(definition, uri);
      if (plan.kind === "own") return plan.result;
      if (plan.kind === "hidden" || !realHas) throw resourceNotFoundError(uri);
      return (await forwardToReal(
        c,
        "resources/read",
        request.params,
        ctx.mcpReq.signal
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
  signal: AbortSignal
): Promise<Obj | undefined> {
  const { definition, realCapabilities, mockCapabilities } = c;
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
  const real: RealItems<SkillEntry> = realHasSkills
    ? await realPages<SkillEntry>(c, "skills/list", "skills", signal)
    : { items: [] };
  const skills = await listMockSkills(definition, real.items);
  if (request.method === "skills/list") {
    const page = pageOf(
      skills,
      request.params?.cursor as string | undefined,
      definition.pageSize ?? real.pageSize
    );
    return {
      skills: page.items,
      ...(page.nextCursor && { nextCursor: page.nextCursor }),
      ...cache,
    };
  }
  const uri = String(request.params?.uri ?? "");
  const listed = skills.find((s) => s.uri === uri);
  if (listed) return { skill: listed, ...cache };
  // A skill the real server serves but never listed: ask it, and adjust what it says.
  if (realHasSkills) {
    try {
      const found = (await forwardToReal(c, "skills/get", { uri }, signal)) as {
        skill?: SkillEntry;
      };
      const adjusted = found.skill
        ? await adjustMockSkill(definition, found.skill)
        : undefined;
      if (adjusted) return { skill: adjusted, ...cache };
    } catch (error) {
      // A skill the real server does not serve is not found here either; any
      // other failure is the real server's (or the host's refusal) and reaches the caller.
      if (!isSkillNotFoundError(error)) throw error;
    }
  }
  throw skillNotFoundError(uri);
}
