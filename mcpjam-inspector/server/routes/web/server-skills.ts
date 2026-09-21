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
 * wrapper, so the SEP's integrity rules cannot diverge between modes. The
 * refusal-as-result shaping is shared too, via `server-skill-route-core.ts`,
 * with the `/api/v1` mirror of these three routes.
 */

import { Hono } from "hono";
import {
  serverSkillsGetSchema,
  serverSkillsListSchema,
  serverSkillsReadFileSchema,
  withEphemeralConnection,
} from "./auth.js";
import {
  getServerSkillCore,
  listServerSkillsCore,
  readServerSkillFileCore,
} from "../../utils/server-skill-route-core.js";

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
      return listServerSkillsCore(manager, body);
    }
  )
);

serverSkills.post("/get", async (c) =>
  withEphemeralConnection(
    c,
    serverSkillsGetSchema,
    async (manager, body, forwardLogMessages) => {
      forwardLogMessages(body.serverId);
      return getServerSkillCore(manager, body);
    }
  )
);

serverSkills.post("/read-file", async (c) =>
  withEphemeralConnection(
    c,
    serverSkillsReadFileSchema,
    async (manager, body, forwardLogMessages) => {
      forwardLogMessages(body.serverId);
      return readServerSkillFileCore(manager, body);
    }
  )
);

export default serverSkills;
