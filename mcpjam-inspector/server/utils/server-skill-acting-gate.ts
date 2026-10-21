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
 * Known gap: the approval the gate raises on `read_server_resource` shows the
 * tool's input, which names the server being read and not the server whose
 * skill is being acted on. The spec asks a cross-origin approval to name
 * both. The banner in the conversation names the origin; the approval pill
 * does not yet.
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
 * Marks a `needsApproval` this gate wrapped and carries the declaration it
 * wrapped. The local org runtime branches on a declaration's TYPE (a literal
 * `true` refuses the turn; a function is left to `streamText`), so it reads
 * through the wrapper with {@link unwrapActingServerSkillGate}.
 */
const WRAPPED_BASE: unique symbol = Symbol("actingServerSkillGate.base");

type GatedNeedsApproval = ((
  input: unknown,
  options: { messages?: ReadonlyArray<ModelMessage> } | undefined
) => Promise<boolean>) & { [WRAPPED_BASE]: unknown };

function isGated(declared: unknown): declared is GatedNeedsApproval {
  return typeof declared === "function" && WRAPPED_BASE in declared;
}

/**
 * The declaration under this gate's wrapper, or `declared` itself when the
 * gate did not wrap it.
 */
export function unwrapActingServerSkillGate(declared: unknown): unknown {
  return isGated(declared) ? declared[WRAPPED_BASE] : declared;
}

/**
 * Whether the gate can answer `true` of its own accord on this turn: a
 * server-served skill is in context and a gated tool is advertised. A
 * runtime that cannot resume after an approval refuses such a turn up front
 * rather than letting the first gated call reach a resume it cannot serve.
 */
export function actingServerSkillGateCanFire(
  tools: Record<string, unknown>,
  messages: ReadonlyArray<ModelMessage> | undefined
): boolean {
  const gated = Object.values(tools).some((tool) =>
    isGated((tool as { needsApproval?: unknown } | undefined)?.needsApproval)
  );
  return gated && mentionsServerSkill(messages);
}

/**
 * Raises the named tools to ask whenever a server-served skill is in context.
 *
 * Raises only: a tool that already asks keeps asking, and is left exactly as
 * declared, since a literal `true` is also what the local org runtime refuses
 * a turn on. Tools absent from the set are left alone, so a turn without a
 * shell is unchanged.
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
    if (original === true) continue;
    const gated = async (
      input: unknown,
      options: { messages?: ReadonlyArray<ModelMessage> } | undefined
    ): Promise<boolean> => {
      const base =
        typeof original === "function"
          ? Boolean(await original(input, options))
          : Boolean(original);
      if (base) return true;
      return mentionsServerSkill(options?.messages);
    };
    out[name] = {
      ...current,
      needsApproval: Object.assign(gated, { [WRAPPED_BASE]: original }),
    };
  }
  return out as T;
}
