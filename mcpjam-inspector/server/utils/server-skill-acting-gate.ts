/**
 * The acting-skill gate for server-served skills (SEP-2640).
 *
 * The spec: a host MUST apply its approval gate to code-execution tool calls
 * issued while acting on an MCP-served skill, and a model-callable resource
 * read reached from skill content is a cross-server confused-deputy vector
 * that MUST be per-call approved. "Acting" is a SKILL.md in context, which
 * the gate reads from the messages the AI SDK hands every approval decision,
 * so it holds across requests and within one. It keys on the banner's marker
 * rather than on a parsed banner (`mentionsServerSkill`), so a banner the
 * parser cannot read still closes the gate.
 *
 * PIN: modelcontextprotocol/ext-skills @ c1aa87e (`specification/stable/skills.mdx`).
 */

import type { ModelMessage } from "ai";
import { mentionsServerSkill } from "../../shared/server-skill-banner.js";

/**
 * Tools that must ask while the model is acting on a server-served skill,
 * whatever the host's approval switch says: the shell, and the workspace
 * read that opens a connection to any saved server.
 */
export const ACTING_SERVER_SKILL_GATED_TOOLS: readonly string[] = [
  "bash",
  "read_server_resource",
];

/**
 * Raises the named tools to ask whenever a server-served skill is in context.
 *
 * Raises only: a tool that already asks keeps asking. Tools absent from the
 * set are left alone, so a turn without a shell is unchanged.
 */
export function applyActingServerSkillGate<T extends Record<string, unknown>>(
  tools: T,
  names: readonly string[] = ACTING_SERVER_SKILL_GATED_TOOLS
): T {
  const out: Record<string, unknown> = { ...tools };
  for (const name of names) {
    const current = out[name];
    if (!current || typeof current !== "object") continue;
    const original = (current as { needsApproval?: unknown }).needsApproval;
    out[name] = {
      ...current,
      needsApproval: async (
        input: unknown,
        options: { messages?: ReadonlyArray<ModelMessage> } | undefined
      ): Promise<boolean> => {
        const base =
          typeof original === "function"
            ? Boolean(await original(input, options))
            : Boolean(original);
        if (base) return true;
        return mentionsServerSkill(options?.messages);
      },
    };
  }
  return out as T;
}
