import { z } from "zod";

const id = z.string().min(1);
export const paneSkillsRequest = z.object({
  projectId: id,
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("client"),
      hostId: id,
      environmentId: id.optional(),
    }),
    z.object({ kind: z.literal("environment"), environmentId: id }),
  ]),
  serverIds: z.array(id).optional(),
  pluginVersionIds: z.array(id).optional(),
});

/** Why a client is not handed a skill. The server's turn plan adds its own. */
export const paneSkillReason = z.enum([
  "unsupported-harness",
  "server-skill-unsupported",
  "plugin-disabled",
  "name-collision",
  "invalid-skill-name",
]);

export const paneSkillsPreview = z.object({
  deliveredCount: z.number().int().nonnegative(),
  skills: z.array(
    z.object({
      skillId: id,
      name: z.string(),
      description: z.string(),
      channels: z.array(
        z.enum(["project", "environment", "host", "plugin", "mcp-server"]),
      ),
      reason: paneSkillReason.nullable(),
      // Optional, so rows from a server that predates them still parse.
      /** Where the skill comes from; `server` names the MCP server it was
       *  captured from. */
      origin: z
        .object({
          kind: z.enum(["library", "plugin", "mcp-server", "local"]),
          server: z.string().optional(),
        })
        .optional(),
      /** The revision a turn would load. `pinned` is true when the
       *  environment names that revision, false when it follows Latest, and
       *  absent when unknown, as for a captured MCP-server skill. */
      version: z
        .object({
          number: z.number().int().positive(),
          pinned: z.boolean().optional(),
        })
        .optional(),
      /** MCPJam's agent can load the skill but leaves it out of the skill
       *  list in its prompt to stay within the model's budget. A preview
       *  names no model, so it sizes that list as for a model of unknown
       *  context; a larger model may list the skill. */
      omittedFromCatalog: z.boolean().optional(),
    }),
  ),
});
export type PaneSkillReason = z.infer<typeof paneSkillReason>;
export type PaneSkillsRequest = z.infer<typeof paneSkillsRequest>;
export type PaneSkillsPreview = z.infer<typeof paneSkillsPreview>;
export type PaneSkillRow = PaneSkillsPreview["skills"][number];

/** Most environments one suite preview reads. */
export const MAX_SUITE_SKILLS_PREVIEW_ENVIRONMENTS = 50;

/** One read over a suite's environments, each planned as an eval run of it. */
export const suiteSkillsPreviewRequest = z.object({
  projectId: id,
  environmentIds: z.array(id).min(1).max(MAX_SUITE_SKILLS_PREVIEW_ENVIRONMENTS),
});

/**
 * One entry per distinct requested environment, in request order. An
 * environment the backend refuses to resolve (deleted, or one it can't run
 * right now) is an entry with the refusal, so the others still read.
 */
export const suiteSkillsPreview = z.object({
  environments: z.array(
    z.discriminatedUnion("ok", [
      z.object({
        environmentId: id,
        ok: z.literal(true),
        preview: paneSkillsPreview,
      }),
      z.object({
        environmentId: id,
        ok: z.literal(false),
        error: z.object({ status: z.number().int(), message: z.string() }),
      }),
    ]),
  ),
});
export type SuiteSkillsPreviewRequest = z.infer<
  typeof suiteSkillsPreviewRequest
>;
export type SuiteSkillsPreview = z.infer<typeof suiteSkillsPreview>;
