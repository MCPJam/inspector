/**
 * Skills served BY a connected MCP server (SEP-2640), local mode.
 *
 * Mounted at `/api/mcp/server-skills` — deliberately NOT `/api/mcp/skills`,
 * which is taken by the filesystem Agent-Skills scan. The two are different
 * things with the same word in the name, and collapsing their routes would
 * make "which skills?" ambiguous at exactly the layer that should not be.
 *
 * Every read goes through `server-skills.ts`, so the SEP's integrity rules
 * hold here identically to the chat path — there is no "just show me the
 * bytes" shortcut, because a debugger that displays unverified content as
 * though it were verified is worse than one that shows nothing.
 */

import { Hono } from "hono";
import "../../types/hono";
import { logger } from "../../utils/logger";
import {
  EXTENSION_INACTIVE_REFUSAL,
  getVerifiedServerSkill,
  isServerSkillRefusalError,
  listServerSkillCatalog,
  readVerifiedServerSkillFile,
} from "../../utils/server-skills.js";

const serverSkills = new Hono();

/**
 * The mutual-declaration state of one connection, so the UI can distinguish
 * "this server has no skills" from "this host never declared the extension" —
 * two very different things a debugger must never conflate.
 */
serverSkills.post("/support", async (c) => {
  try {
    const body = (await c.req.json()) as { serverId?: string };
    if (!body.serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    return c.json({
      success: true,
      support: c.mcpClientManager.getSkillsSupport(body.serverId),
    });
  } catch (error) {
    logger.error("Error reading skills support", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

serverSkills.post("/list", async (c) => {
  let serverId: string | undefined;
  try {
    const body = (await c.req.json()) as { serverId?: string };
    serverId = body.serverId;
    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const support = c.mcpClientManager.getSkillsSupport(serverId);
    if (!support.active) {
      // 200 with an inactive support block, not an error: "this connection
      // does not speak skills" is a normal state the UI renders, not a failure.
      // Full shape, including the empty arrays, so a consumer never has to
      // branch on which mode answered.
      return c.json({
        success: true,
        support,
        serverId,
        skills: [],
        duplicateUris: [],
        rejected: [],
      });
    }
    const listing = await listServerSkillCatalog(c.mcpClientManager, serverId);
    return c.json({ success: true, support, ...listing });
  } catch (error) {
    logger.error("Error listing server skills", error, { serverId });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * Load one skill by URI, verified.
 *
 * Works for skills the listing never mentioned — the "Load by URI" affordance
 * in the Skills tab, and the same path a skill URI from server `instructions`
 * takes.
 */
serverSkills.post("/get", async (c) => {
  let serverId: string | undefined;
  try {
    const body = (await c.req.json()) as { serverId?: string; uri?: string };
    serverId = body.serverId;
    if (!serverId || !body.uri) {
      return c.json(
        { success: false, error: "serverId and uri are required" },
        400
      );
    }
    // Same short-circuit as `/list`: an inactive connection is a STATE, and
    // letting the SDK's refusal surface as a generic failure here would erase
    // the distinction the UI renders.
    const support = c.mcpClientManager.getSkillsSupport(serverId);
    if (!support.active) {
      // Carries a REFUSAL, not a bare null: the client's unwrap synthesizes a
      // generic `fetch_failed` for a failed response with no refusal, which
      // would report a network problem for what is actually a capability
      // state — the exact distinction this branch exists to preserve.
      return c.json({
        success: false,
        support,
        refusal: EXTENSION_INACTIVE_REFUSAL,
      });
    }
    const skill = await getVerifiedServerSkill(c.mcpClientManager, {
      serverId,
      uri: body.uri,
    });
    return c.json({ success: true, skill });
  } catch (error) {
    if (isServerSkillRefusalError(error)) {
      // A refusal is a RESULT, not a server fault: it carries the specific
      // violation the user needs to see, so it rides a 200 with `success:false`
      // rather than being flattened into a 500.
      return c.json({ success: false, refusal: error.refusal });
    }
    logger.error("Error loading server skill", error, { serverId });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

serverSkills.post("/read-file", async (c) => {
  try {
    const body = (await c.req.json()) as {
      serverId?: string;
      skillUri?: string;
      resourceUri?: string;
    };
    if (!body.serverId || !body.skillUri || !body.resourceUri) {
      return c.json(
        {
          success: false,
          error: "serverId, skillUri, and resourceUri are required",
        },
        400
      );
    }
    const support = c.mcpClientManager.getSkillsSupport(body.serverId);
    if (!support.active) {
      return c.json({
        success: false,
        support,
        refusal: EXTENSION_INACTIVE_REFUSAL,
      });
    }
    // Re-fetch the entry rather than trusting a client-supplied manifest: the
    // manifest IS the read allowlist, so accepting one from the caller would
    // let the caller authorize its own read.
    const skill = await getVerifiedServerSkill(c.mcpClientManager, {
      serverId: body.serverId,
      uri: body.skillUri,
    });
    const file = await readVerifiedServerSkillFile(c.mcpClientManager, {
      serverId: body.serverId,
      entry: { uri: skill.skillUri, resources: skill.resources },
      resourceUri: body.resourceUri,
    });
    return c.json({ success: true, file });
  } catch (error) {
    if (isServerSkillRefusalError(error)) {
      return c.json({ success: false, refusal: error.refusal });
    }
    logger.error("Error reading server skill file", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default serverSkills;
