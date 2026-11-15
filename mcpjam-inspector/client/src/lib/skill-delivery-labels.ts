/**
 * What a person reads about a skill a turn leaves out, for each reason the
 * turn plan gives (`SkillExclusionReason`, the skills preview's row `reason`).
 * The Compare pane's skill list and the Playground's environment notice both
 * take their wording from here, so one reason reads the same everywhere.
 *
 * A client whose runtime takes skills is never told it doesn't support them.
 * When it can't load one, the limit is in what MCPJam hands it, so the line
 * says the skill doesn't load on it yet.
 */
import type { PaneSkillReason } from "@/shared/pane-skills-preview";

export interface SkillReasonSubject {
  /** The client by name; "this client" when the line sits under it. */
  client?: string;
  /** The MCP server the skill comes from (the row's `origin.server`). */
  server?: string;
}

const LABELS = {
  "unsupported-harness": ({ client }) => `Skills don’t load on ${client} yet.`,
  "server-skill-unsupported": ({ client, server }) =>
    `Skills from ${server ?? "MCP servers"} don’t load on ${client} yet.`,
  "plugin-disabled": () => "Its plugin is turned off for this pane.",
  "name-collision": () => "Another skill with this name takes precedence.",
  "invalid-skill-name": () => "This client can’t use this skill name.",
  "over-cap": () => "Over the skill limit, so it doesn’t load.",
} satisfies Record<
  PaneSkillReason,
  (subject: { client: string; server?: string }) => string
>;

export function skillExclusionLabel(
  reason: PaneSkillReason,
  { client = "this client", server }: SkillReasonSubject = {},
): string {
  return LABELS[reason]({ client, server });
}

/**
 * A delivered skill MCPJam's agent leaves off the skill list in its prompt to
 * fit the model's context (`omittedFromCatalog`). The model still loads it
 * when the person names it.
 */
export const UNLISTED_SKILL_NOTE =
  "Not in the model’s skill list. Ask for it by name to use it.";
