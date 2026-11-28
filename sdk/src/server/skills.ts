import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MCP_SKILLS_EXTENSION_ID } from "../mcp-client-manager/skills-dispatch.js";
import { sha256HexOfBytes } from "../mcp-client-manager/skills-integrity.js";
import type { SkillEntry } from "../mcp-client-manager/skills-ext-types.js";

/**
 * The server half of the skills extension (`io.modelcontextprotocol/skills`,
 * SEP-2640), shared by MCPJam's mock servers and its hosted MCP server. A
 * skill is listed with a manifest of its files, each with the SHA-256 and
 * size of what the server will serve, so a host that checks digests accepts
 * it.
 */

export const SKILLS_EXTENSION_ID = MCP_SKILLS_EXTENSION_ID;

/**
 * The extension as a server declares it: `{}`, supported with no optional
 * features. A host reads the value as an object, so `true` would not count.
 */
export function skillsCapability(): {
  [SKILLS_EXTENSION_ID]: Record<string, never>;
} {
  return { [SKILLS_EXTENSION_ID]: {} };
}

/** The manifest row for one served file: what a host checks its read against. */
export async function skillManifestEntry(
  uri: string,
  bytes: Uint8Array
): Promise<{ uri: string; digest: string; size: number }> {
  return {
    uri,
    digest: `sha256:${await sha256HexOfBytes(bytes)}`,
    size: bytes.byteLength,
  };
}

/** `-32602` for a skill the server does not have, as the extension asks; `data` adds to the URI. */
export function skillNotFoundError(
  uri: string,
  data: Record<string, unknown> = {}
): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Skill ${uri} not found`,
    { ...data, uri }
  );
}

/** How long a client may cache a `skills/list` or `skills/get` answer, and for whom (SEP-2549). */
export interface SkillsCachePolicy {
  ttlMs: number;
  cacheScope: "public" | "private";
}

export interface SkillsSource extends SkillsCachePolicy {
  /** One page of the catalog. Throw to refuse a cursor the server did not issue. */
  list(cursor: string | undefined): Promise<{ skills: SkillEntry[]; nextCursor?: string }> | { skills: SkillEntry[]; nextCursor?: string };
  /** One skill, or `undefined` when the server has none at `uri`. */
  get(uri: string): Promise<SkillEntry | undefined> | SkillEntry | undefined;
}

const listParams = z.object({ cursor: z.string().optional() }).loose();
const getParams = z.object({ uri: z.string().min(1) }).loose();
// Loose: these check what the server itself returns.
const anyResult = z.looseObject({});

/**
 * Registers `skills/list` and `skills/get` on a server. Neither method is in a
 * protocol codec, so they use the form with explicit schemas, which also
 * serves every protocol revision. Both answers carry the cache fields the
 * extension requires, since the SDK fills them only for base methods. Call it
 * once per server: a second registration silently replaces the first.
 */
export function registerSkillsMethods(server: McpServer, source: SkillsSource): void {
  const cache = { ttlMs: source.ttlMs, cacheScope: source.cacheScope };
  server.server.setRequestHandler(
    "skills/list",
    { params: listParams, result: anyResult },
    async (params) => {
      const page = await source.list(params.cursor);
      return {
        skills: page.skills,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
        ...cache,
      };
    }
  );
  server.server.setRequestHandler(
    "skills/get",
    { params: getParams, result: anyResult },
    async (params) => {
      const skill = await source.get(params.uri);
      if (!skill) throw skillNotFoundError(params.uri);
      return { skill, ...cache };
    }
  );
}
