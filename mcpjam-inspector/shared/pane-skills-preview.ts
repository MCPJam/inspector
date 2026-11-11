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
    }),
  ),
});
export type PaneSkillReason = z.infer<typeof paneSkillReason>;
export type PaneSkillsRequest = z.infer<typeof paneSkillsRequest>;
export type PaneSkillsPreview = z.infer<typeof paneSkillsPreview>;
export type PaneSkillRow = PaneSkillsPreview["skills"][number];
