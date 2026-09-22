/**
 * `io.modelcontextprotocol/skills` (SEP-2640) client operations.
 *
 * The extension is negotiated CONNECTION-LEVEL (SEP-2133): both sides declare
 * it in `initialize`, and nothing rides `params._meta`. That makes this module
 * much thinner than its tasks counterpart — there is no per-request
 * eligibility envelope to reconstruct, no `subscriptions/listen` seam, and no
 * era gate (see `skills-dispatch.ts` for why `skills/*` is era-blind).
 *
 * What remains is the ONE upstream construct that still stands between an
 * extension method and a socket: the result-schema seam. The schema-less
 * `Protocol.request` overload resolves its validator from the negotiated era's
 * codec registry, which returns `undefined` for every extension method and
 * makes the call throw "'…' is not a spec method". So every request here rides
 * `requestWithSchema` with a deliberately loose wire schema, and the real
 * validation is the zod mirror in `skills-ext-guards.ts` — which can report
 * WHICH field of WHICH entry failed, where upstream would report only
 * "invalid result".
 */

import { z } from "zod";
import type { ManagedMcpClient } from "./managed-mcp-client.js";
import type { ClientRequestOptions } from "./types.js";
import {
  assertDirectoryReadResult,
  assertSkillsGetResult,
  assertSkillsListResult,
} from "./skills-ext-guards.js";
import type {
  SkillEntry,
  SkillsDirectoryReadResult,
  SkillsExtListResult,
} from "./skills-ext-types.js";

export { MCP_SKILLS_EXTENSION_ID } from "./skills-dispatch.js";

/** The extension's request methods. */
export const SkillsExtListMethod = "skills/list" as const;
export const SkillsExtGetMethod = "skills/get" as const;
/** OPTIONAL, gated on the server's `{ directoryRead: true }` setting. */
export const SkillsExtDirectoryReadMethod = "resources/directory/read" as const;

export const SkillsExtRequestMethods = [
  SkillsExtListMethod,
  SkillsExtGetMethod,
  SkillsExtDirectoryReadMethod,
] as const;

export type SkillsExtRequestMethod = (typeof SkillsExtRequestMethods)[number];

/**
 * Wire-level result schema for every extension request.
 *
 * Deliberately loose, exactly like the tasks extension's
 * `TASKS_EXT_WIRE_RESULT_SCHEMA`: the real validation is the zod mirror in
 * `skills-ext-guards.ts`. A strict schema here would surface upstream's
 * generic "invalid result" and lose the per-field diagnosis a debugger exists
 * to provide.
 */
const SKILLS_EXT_WIRE_RESULT_SCHEMA = z.looseObject({});

export interface SkillsExtCallContext {
  client: ManagedMcpClient;
  options?: ClientRequestOptions;
}

async function sendSkillsExtRequest(
  ctx: SkillsExtCallContext,
  method: SkillsExtRequestMethod,
  params: Record<string, unknown>
): Promise<unknown> {
  return ctx.client.requestWithSchema(
    { method, params },
    SKILLS_EXT_WIRE_RESULT_SCHEMA,
    ctx.options
  );
}

/**
 * `skills/list` — one page.
 *
 * A listing MAY be empty or partial BY SPEC, and callers must never read
 * absence from it as proof a skill does not exist. That is why the capture
 * path confirms disappearance with a `skills/get` probe rather than with a
 * drained listing (see `missingSince` in the capture store).
 *
 * SEP-2549 `ttlMs` / `cacheScope` ride through untouched.
 */
export async function listSkillsExt(
  ctx: SkillsExtCallContext,
  params?: { cursor?: string }
): Promise<SkillsExtListResult> {
  const result = await sendSkillsExtRequest(
    ctx,
    SkillsExtListMethod,
    // Presence, not truthiness: `""` is a valid continuation cursor.
    params?.cursor !== undefined ? { cursor: params.cursor } : {}
  );
  return assertSkillsListResult(result);
}

/**
 * `skills/get` — one skill by URI.
 *
 * Works for skills the listing never mentioned, which is the whole reason the
 * method exists: a skill URI can reach the host from server `instructions`,
 * from another skill's body, or from the user. A conforming server answers
 * `-32602` for a URI it does not serve, and that answer — not an absent
 * listing entry — is what proves non-existence.
 */
export async function getSkillExt(
  ctx: SkillsExtCallContext,
  uri: string
): Promise<SkillEntry> {
  const result = await sendSkillsExtRequest(ctx, SkillsExtGetMethod, { uri });
  // The result is an ENVELOPE, `{ skill }` — unwrapped by the guard so the
  // wire shape stays known in one place.
  return assertSkillsGetResult(result);
}

/**
 * `resources/directory/read` — the OPTIONAL readdir for `inode/directory`
 * resources.
 *
 * Callers MUST gate on `skillsDirectoryReadEnabled(serverCapabilities)` before
 * reaching here: the method is opt-in per the extension's `directoryRead`
 * setting, and sending it to a server that did not opt in is exactly the kind
 * of undeclared probe the advertise=enforce rule forbids.
 */
export async function readResourceDirectoryExt(
  ctx: SkillsExtCallContext,
  params: { uri: string; cursor?: string }
): Promise<SkillsDirectoryReadResult> {
  const result = await sendSkillsExtRequest(
    ctx,
    SkillsExtDirectoryReadMethod,
    params.cursor
      ? { uri: params.uri, cursor: params.cursor }
      : { uri: params.uri }
  );
  return assertDirectoryReadResult(result);
}

/**
 * The JSON-RPC code a conforming server answers for a `skills/get` on a URI it
 * does not serve — `-32602`, which is the GENERIC *Invalid params*.
 */
export const SKILL_NOT_FOUND_ERROR_CODE = -32602;

/**
 * Whether the server rejected the params for this `skills/get`.
 *
 * ## What this does and does NOT prove
 *
 * `-32602` is generic. A conforming server also returns it for a malformed
 * `uri`, a wrong parameter type, or a missing parameter, and nothing in
 * SEP-2640 mandates a discriminator that would separate those from "no such
 * skill". So this predicate means "the server rejected these params", NOT "the
 * skill does not exist".
 *
 * That distinction matters because the capture path uses this signal to record
 * disappearance. A client-side request defect must not be written down as a
 * skill deletion — the one conclusion the SEP forbids drawing from absence. A
 * caller recording disappearance therefore needs the URI to have been captured
 * successfully BEFORE (so the params are known-good), which is exactly the
 * condition the capture coordinator probes under.
 *
 * The code is read from the top level and from a nested `error.code`, because
 * transports and adapters wrap JSON-RPC errors differently and a missed
 * unwrap would silently turn "rejected" into "inconclusive".
 */
export function isSkillNotFoundError(error: unknown): boolean {
  const direct = (error as { code?: unknown } | undefined)?.code;
  if (typeof direct === "number") {
    return direct === SKILL_NOT_FOUND_ERROR_CODE;
  }
  const nested = (error as { error?: { code?: unknown } } | undefined)?.error
    ?.code;
  return nested === SKILL_NOT_FOUND_ERROR_CODE;
}
