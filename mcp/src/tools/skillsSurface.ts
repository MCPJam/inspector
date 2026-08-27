/**
 * `io.modelcontextprotocol/skills` (SEP-2640) — the SERVER half.
 *
 * MCPJam ships Agent Skills for authoring evals, and until now the only way to
 * get them was to run an installer. This server's tools are the eval surface —
 * suites, runs, scenarios — so a caller here is working on evals, and these are
 * the skills about evals. The extension exists so that connecting to a server
 * delivers its tools AND the relevant how-to knowledge in one step.
 *
 * Precision, because an earlier version of this comment claimed more: only
 * `run-mcpjam-evals` teaches these tools. The rest teach authoring the eval
 * files and suites the tools OPERATE on. `WORKER_SKILL_ROOTS` in the generator
 * carries the full inclusion/exclusion reasoning.
 *
 * ## Everything here is precomputed
 *
 * `SkillsBundle.generated.ts` carries complete entries — manifest, digests,
 * sizes — built by `scripts/generate-skills-bundle.mjs`. So `skills/list` and
 * `skills/get` are literal returns and `resources/read` is a map lookup:
 * nothing is hashed per request, which matters under a worker CPU budget. The
 * generator, not this module, is where correctness is enforced; it fails the
 * build on anything MCPJam's own host would refuse.
 *
 * ## Why the custom-method form
 *
 * `skills/list` and `skills/get` are in no protocol codec, so the 2-arg
 * `setRequestHandler` overload — which resolves a validator from the negotiated
 * era's registry — would throw "not a spec request method". The 3-arg form
 * carries explicit schemas and bypasses that entirely, which is also what makes
 * these methods era-blind: the dispatch gate only fires for methods some codec
 * knows, so one registration serves both the modern and legacy-stateless wires.
 *
 * ## Static resources, not a template
 *
 * Each manifest file is registered individually. A `ResourceTemplate` matching
 * `skill://{+path}` would work mechanically, but it would advertise a wildcard
 * claim over the entire `skill://` scheme in `resources/templates/list` — a
 * poor look for a debugger, and an implicit promise to serve URIs we do not
 * have. Concrete rows also make the surface self-describing in a Resources tab.
 * Integrity does not depend on either choice: a host resolves reads through the
 * manifest, never through `resources/list`.
 *
 * ## Always advertised
 *
 * The worker is stateless, so the declaration cannot be gated on the client's
 * own `extensions`. That is correct rather than a compromise — SEP-2133
 * negotiates connection-level, and the client half of the gate is the client's
 * to enforce — but it is the same shape of deviation documented at the top of
 * `sessionToolRegistrar.ts`, and worth reading alongside it.
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

/** The extension id, and the capability value the server declares. */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

/**
 * Declared capabilities for the extension.
 *
 * `{}` — supported, no optional features. NOT `true`: the capability map is
 * `{ [id]: settingsObject }`, and a conforming host reads the value as an
 * object, so a boolean does not count as a declaration at all. `directoryRead`
 * is omitted because we do not implement `resources/directory/read`; the
 * manifest already enumerates every file, and advertising an opt-in we cannot
 * answer is exactly the undeclared-surface problem in reverse.
 */
export const SKILLS_EXTENSION_CAPABILITY = {
  [SKILLS_EXTENSION_ID]: {},
} as const;

/**
 * How long a client may cache a `skills/list` result (SEP-2549), and the scope
 * that cache entry is valid for.
 *
 * The catalog is baked into the bundle at build time, so it cannot change
 * without a deploy — an hour is an honest statement about this server rather
 * than a guessed default. The listing is public and does not vary by caller,
 * so its SEP-2549 cache scope is `public`.
 */
export const SKILLS_LIST_TTL_MS = 60 * 60 * 1000;
export const SKILLS_LIST_CACHE_SCOPE = "public";

/** JSON-RPC Invalid params — what the draft mandates for an unknown skill URI. */
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

/**
 * The wire result schemas.
 *
 * Loose on purpose. These validate what WE emit, and the bundle is generated
 * from a gate that has already checked far more than a shape — a strict mirror
 * here would be a second, weaker copy of the generator's rules that could
 * disagree with it.
 */
const looseResult = z.looseObject({});

/**
 * The media type for a skill file.
 *
 * `.yaml` matters here: two of the bundled files are eval suites, and calling
 * them `text/plain` misdescribes content a reader may well want to parse.
 */
function mimeTypeFor(uri: string): string {
  if (uri.endsWith(".md")) return "text/markdown";
  if (uri.endsWith(".yaml") || uri.endsWith(".yml")) return "application/yaml";
  return "text/plain";
}

function entryFor(uri: string): SkillsBundleEntry {
  const entry = SKILLS_BUNDLE_ENTRIES.find((skill) => skill.uri === uri);
  if (!entry) {
    throw new InvalidSkillParamsError(`Unknown skill URI: ${uri}`);
  }
  return entry;
}

/**
 * Registers `skills/list`, `skills/get`, and one resource per manifest file.
 *
 * Call ONCE per server. The low-level `setRequestHandler` silently overwrites a
 * duplicate registration rather than throwing, so a second call would not
 * announce itself.
 */
export function registerSkillsSurface(server: McpServer): void {
  server.server.setRequestHandler(
    "skills/list",
    { params: listParamsSchema, result: looseResult },
    async (params) => {
      // The whole catalog fits one page, so no cursor is ever issued and none
      // is valid. Rejecting an unrecognised cursor beats ignoring it: a client
      // that believes it is paginating would otherwise loop on page one
      // forever, having been told nothing was wrong.
      const cursor = params.cursor;
      if (cursor !== undefined) {
        throw new InvalidSkillParamsError(
          `Unknown cursor: ${cursor}. This server returns its whole skill catalog in one page and issues no cursor.`
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
    const mimeType = mimeTypeFor(uri);
    server.registerResource(
      uri,
      uri,
      {
        mimeType,
        description: "Agent Skill file served over MCP (SEP-2640).",
      },
      // The SAME `mimeType` on the content, not just the registration. A
      // reader gets the type from `contents[0]`, not from `resources/list` —
      // MCPJam's own loader names it in the refusal for a non-text read — so
      // declaring it in one place and omitting it in the other tells two
      // different stories about the same file.
      async () => ({ contents: [{ uri, mimeType, text }] })
    );
  }
}
