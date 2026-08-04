/**
 * Skills served BY a connected MCP server (SEP-2640), hosted mode.
 *
 * Mounted at `/api/web/server-skills` — a DISTINCT path from
 * `/api/web/skills`, which serves the project's durable Convex skills. Same
 * word, different thing.
 *
 * Hosted connections are ephemeral (one per request), so the skills extension
 * is declared or not by the HOST's stored `clientCapabilities` — which is why
 * only the MCPJam persona advertises it by default, and why the host builder's
 * "Skills over MCP" switch is how any other persona opts in for testing.
 *
 * Every read shares `server-skills.ts` with the local routes and the chat
 * wrapper, so the SEP's integrity rules cannot diverge between modes.
 */

import { Hono } from "hono";
import {
  serverSkillsGetSchema,
  serverSkillsListSchema,
  serverSkillsReadFileSchema,
  withEphemeralConnection,
} from "./auth.js";
import {
  EXTENSION_INACTIVE_REFUSAL,
  getVerifiedServerSkill,
  isServerSkillRefusalError,
  listServerSkillCatalog,
  readVerifiedServerSkillFile,
} from "../../utils/server-skills.js";

const serverSkills = new Hono();

serverSkills.post("/list", async (c) =>
  withEphemeralConnection(
    c,
    serverSkillsListSchema,
    async (manager, body, forwardLogMessages) => {
      // Server-side `notifications/message` records ride the request's RPC log
      // collector; without this, a discovery failure loses the server's own
      // diagnostic output — which is most of what a debugger user needs.
      forwardLogMessages(body.serverId);
      const support = manager.getSkillsSupport(body.serverId);
      if (!support.active) {
        // Not an error: "this connection does not speak skills" is a state the
        // UI renders, and conflating it with a failure would hide the reason.
        // `serverId` is included so the payload shape matches the active
        // branch, which spreads it from the listing.
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
  )
);

serverSkills.post("/get", async (c) =>
  withEphemeralConnection(
    c,
    serverSkillsGetSchema,
    async (manager, body, forwardLogMessages) => {
      forwardLogMessages(body.serverId);
      const support = manager.getSkillsSupport(body.serverId);
      // A refusal, not a bare null — the client's unwrap turns a missing
      // refusal into a generic `fetch_failed`, which would report a network
      // problem for what is actually a capability state.
      if (!support.active)
        return {
          support,
          refusal: EXTENSION_INACTIVE_REFUSAL,
        };
      try {
        return {
          support,
          skill: await getVerifiedServerSkill(manager, {
            serverId: body.serverId,
            uri: body.uri,
          }),
        };
      } catch (error) {
        if (isServerSkillRefusalError(error)) {
          // A refusal is a RESULT carrying the specific violation, not a fault.
          return { support, refusal: error.refusal };
        }
        throw error;
      }
    }
  )
);

serverSkills.post("/read-file", async (c) =>
  withEphemeralConnection(
    c,
    serverSkillsReadFileSchema,
    async (manager, body, forwardLogMessages) => {
      forwardLogMessages(body.serverId);
      const support = manager.getSkillsSupport(body.serverId);
      if (!support.active)
        return {
          support,
          refusal: EXTENSION_INACTIVE_REFUSAL,
        };
      try {
        // The entry is re-fetched rather than taken from the caller: the
        // manifest IS the read allowlist, so a client-supplied one would let
        // the client authorize its own read.
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
        if (isServerSkillRefusalError(error)) {
          return { support, refusal: error.refusal };
        }
        throw error;
      }
    }
  )
);

export default serverSkills;
