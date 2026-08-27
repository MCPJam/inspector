/**
 * Route-shaped cores for server-served skills (SEP-2640).
 *
 * `server-skills.ts` (now `@mcpjam/sdk`) owns the integrity chain and signals a
 * violation by THROWING a structured refusal. An HTTP surface wants the
 * opposite shape: a refusal is a RESULT, because "this skill cannot be verified,
 * and here is exactly which check failed" is the answer a debugger's user asked
 * for, not a fault. These three functions are that translation, and they live
 * here so `/api/web/server-skills` and `/v1/.../skills` cannot drift in it.
 *
 * The alternative — each route doing its own try/catch — is how `/get` and
 * `/read-file` would eventually disagree about whether an inactive extension is
 * a 200 with a refusal or a 500, and the client renders a missing refusal as a
 * generic `fetch_failed`: a network story for what is a capability state.
 */

import type { MCPClientManager } from "@mcpjam/sdk";
import {
  EXTENSION_INACTIVE_REFUSAL,
  getVerifiedServerSkill,
  isServerSkillRefusalError,
  listServerSkillCatalog,
  readVerifiedServerSkillFile,
} from "./server-skills.js";

type Manager = InstanceType<typeof MCPClientManager>;

/**
 * The catalog, or an inactive-extension answer shaped identically to it.
 *
 * `serverId` is spread from the listing on the active path and supplied
 * explicitly on the inactive one, so a caller never has to branch on which
 * answer it got to find out which server it asked about.
 */
export async function listServerSkillsCore(
  manager: Manager,
  body: { serverId: string }
) {
  const support = manager.getSkillsSupport(body.serverId);
  if (!support.active) {
    return {
      support,
      serverId: body.serverId,
      skills: [],
      duplicateUris: [],
      rejected: [],
    };
  }
  const listing = await listServerSkillCatalog(manager, body.serverId);
  return { support, ...listing };
}

/** One verified skill, or the refusal that stopped it. */
export async function getServerSkillCore(
  manager: Manager,
  body: { serverId: string; uri: string }
) {
  const support = manager.getSkillsSupport(body.serverId);
  if (!support.active) return { support, refusal: EXTENSION_INACTIVE_REFUSAL };
  try {
    return {
      support,
      skill: await getVerifiedServerSkill(manager, {
        serverId: body.serverId,
        uri: body.uri,
      }),
    };
  } catch (error) {
    if (isServerSkillRefusalError(error)) return { support, refusal: error.refusal };
    throw error;
  }
}

/** One verified supporting file, or the refusal that stopped it. */
export async function readServerSkillFileCore(
  manager: Manager,
  body: { serverId: string; skillUri: string; resourceUri: string }
) {
  const support = manager.getSkillsSupport(body.serverId);
  if (!support.active) return { support, refusal: EXTENSION_INACTIVE_REFUSAL };
  try {
    // The entry is re-fetched rather than taken from the caller: the manifest
    // IS the read allowlist, so a client-supplied one would let the client
    // authorize its own read.
    const skill = await getVerifiedServerSkill(manager, {
      serverId: body.serverId,
      uri: body.skillUri,
    });
    return {
      support,
      file: await readVerifiedServerSkillFile(manager, {
        serverId: body.serverId,
        entry: { uri: skill.skillUri, resources: skill.resources },
        resourceUri: body.resourceUri,
      }),
    };
  } catch (error) {
    if (isServerSkillRefusalError(error)) return { support, refusal: error.refusal };
    throw error;
  }
}
