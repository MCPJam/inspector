/**
 * `io.modelcontextprotocol/skills` (SEP-2640) for the CLI's stdio server.
 *
 * `mcpjam mcp` exposes `connect_server`, `call_tool`, `server_doctor`, the
 * OAuth walkthrough, and apps conformance — and MCPJam ships a skill,
 * `mcp-inspector`, whose entire subject is how to interpret that output
 * conservatively. Serving it here means an agent that connects to the CLI gets
 * the interpretation rules with the tools, instead of a user being told to run
 * `npx skills add` first.
 *
 * ## Deliberately a second implementation
 *
 * This mirrors `mcp/src/tools/skillsSurface.ts` rather than importing it. The
 * worker is a private Cloudflare package with no Node build output, so a
 * runtime import across the two is not available; publishing the registrar
 * through `@mcpjam/sdk` would work but costs an SDK release before the CLI —
 * which depends on the PUBLISHED `@mcpjam/sdk` — could consume it.
 *
 * What is NOT duplicated is the part that can silently disagree: the bundle
 * GENERATOR is shared (`cli/scripts/generate-skills-bundle.mjs` calls the
 * worker's builder), so both venues compute digests and sizes with the same
 * code. Two copies of the manifest math would surface to a user as a
 * `digest_mismatch` from a server serving the right bytes. Two copies of
 * `setRequestHandler` wiring cannot.
 *
 * If a third venue appears, or this grows past thin wiring, promote it.
 *
 * PIN: modelcontextprotocol/modelcontextprotocol @ a3e147ca27 (branch `sep/skills-extension`, `seps/2640-skills-extension.md`).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  SKILLS_BUNDLE_CONTENTS,
  SKILLS_BUNDLE_ENTRIES,
  type SkillsBundleEntry,
} from "../generated/SkillsBundle.generated.js";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

/**
 * `{}` — supported, no optional features. NOT `true`: a host reads the value
 * as the settings object, so a boolean is not a declaration at all.
 * `directoryRead` is omitted because `resources/directory/read` is not
 * implemented here either.
 */
export const SKILLS_EXTENSION_CAPABILITY = {
  [SKILLS_EXTENSION_ID]: {},
} as const;

/**
 * The catalog is compiled into the binary, so it changes only on release. It
 * is public and does not vary by caller, so SEP-2549 calls for a `public`
 * cache scope.
 */
export const SKILLS_LIST_TTL_MS = 60 * 60 * 1000;
export const SKILLS_LIST_CACHE_SCOPE = "public";

const INVALID_PARAMS = -32602;

class InvalidSkillParamsError extends Error {
  readonly code = INVALID_PARAMS;
  constructor(message: string) {
    super(message);
    this.name = "InvalidSkillParamsError";
  }
}

const listParamsSchema = z.object({ cursor: z.string().optional() }).loose();
const getParamsSchema = z.object({ uri: z.string().min(1) }).loose();
const looseResult = z.looseObject({});

function entryFor(uri: string): SkillsBundleEntry {
  const entry = SKILLS_BUNDLE_ENTRIES.find((skill) => skill.uri === uri);
  if (!entry) {
    throw new InvalidSkillParamsError(`Unknown skill URI: ${uri}`);
  }
  return entry;
}

/** Registers `skills/list`, `skills/get`, and one resource per manifest file. */
export function registerSkillsSurface(server: McpServer): void {
  server.server.setRequestHandler(
    "skills/list",
    { params: listParamsSchema, result: looseResult },
    async (params) => {
      // The catalog fits one page, so no cursor is ever issued. Ignoring one
      // would leave a paginating client looping on page one, told nothing was
      // wrong.
      if (params.cursor !== undefined) {
        throw new InvalidSkillParamsError(
          `Unknown cursor: ${params.cursor}. This server returns its whole skill catalog in one page and issues no cursor.`
        );
      }
      return {
        skills: SKILLS_BUNDLE_ENTRIES,
        ttlMs: SKILLS_LIST_TTL_MS,
        cacheScope: SKILLS_LIST_CACHE_SCOPE,
      };
    }
  );

  server.server.setRequestHandler(
    "skills/get",
    { params: getParamsSchema, result: looseResult },
    async (params) => ({ skill: entryFor(params.uri) })
  );

  for (const [uri, text] of Object.entries(SKILLS_BUNDLE_CONTENTS)) {
    server.registerResource(
      uri,
      uri,
      {
        mimeType: uri.endsWith(".md") ? "text/markdown" : "text/plain",
        description: "Agent Skill file served over MCP (SEP-2640).",
      },
      async () => ({ contents: [{ uri, text }] })
    );
  }
}
