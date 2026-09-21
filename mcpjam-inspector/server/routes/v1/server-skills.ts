/**
 * Skills served BY a connected MCP server (SEP-2640) — the agent-reachable
 * mirror of `/api/web/server-skills`.
 *
 * The web routes exist so the Skills tab can show what a server serves. These
 * exist so anything driving MCPJam through `/api/v1` — the platform operations,
 * and through them the hosted worker's tool catalog and the in-app agent — can
 * see the same thing. Skills was the only primitive-shaped surface in MCPJam
 * with no agent-reachable inspection path; tools, resources and prompts all had
 * one.
 *
 * Same cores as the web routes (`server-skill-route-core.ts`), so a refusal
 * reads identically on both, and the same verified read path underneath, so
 * there is no route that can serve unverified skill bytes.
 *
 * NOT paginated, unlike `/resources`: `listServerSkillCatalog` drains
 * `skills/list` internally, and a page boundary in the middle of a catalog
 * whose duplicate detection spans the whole listing would report contradictions
 * that depend on where the caller stopped.
 */

import { Hono } from "hono";
import {
  serverSkillsGetSchema,
  serverSkillsListSchema,
  serverSkillsReadFileSchema,
} from "../web/auth.js";
import {
  getServerSkillCore,
  listServerSkillsCore,
  readServerSkillFileCore,
} from "../../utils/server-skill-route-core.js";
import { runV1ServerOp } from "./adapter.js";
import { v1Resource } from "./envelope.js";

const serverSkills = new Hono();

// POST /v1/projects/:projectId/servers/:serverId/skills
// The server's skill catalog, including skills it advertises but MCPJam
// declines to load (`unloadable`), URIs it listed twice, and entries whose
// manifests were rejected outright.
serverSkills.post("/projects/:projectId/servers/:serverId/skills", async (c) =>
  runV1ServerOp(
    c,
    serverSkillsListSchema,
    (manager, body) => listServerSkillsCore(manager, body),
    (ctx, result) => v1Resource(ctx, result)
  )
);

// POST /v1/projects/:projectId/servers/:serverId/skills/get
// One skill by uri, verified. Distinct from a listing entry: `skills/get`
// reaches skills a partial listing never mentioned, which is why the SEP has
// it at all.
serverSkills.post(
  "/projects/:projectId/servers/:serverId/skills/get",
  async (c) =>
    runV1ServerOp(
      c,
      serverSkillsGetSchema,
      (manager, body) => getServerSkillCore(manager, body),
      (ctx, result) => v1Resource(ctx, result)
    )
);

// POST /v1/projects/:projectId/servers/:serverId/skills/read-file
// One supporting file, verified against the skill's own manifest.
serverSkills.post(
  "/projects/:projectId/servers/:serverId/skills/read-file",
  async (c) =>
    runV1ServerOp(
      c,
      serverSkillsReadFileSchema,
      (manager, body) => readServerSkillFileCore(manager, body),
      (ctx, result) => v1Resource(ctx, result)
    )
);

export default serverSkills;
