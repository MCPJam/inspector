/**
 * Which plugin names a manifest may declare.
 *
 * Two rules that overlap without matching: Agent Plugins 1.0's allows `.` and
 * only lowercase; the ChatGPT portal's allows uppercase and `_` and refuses
 * `.`. `strict` reads Agent Plugins' alone. `openai-compatible` accepts a name
 * either rule accepts, so every package that imported before still imports
 * and every name the portal accepts imports too; it refuses in the portal's
 * words. The readiness reader grades the portal's rule alone.
 */

import {
  PLUGIN_PORTAL_RULES,
  type PluginPortalRuleCode,
} from "./portal-rules.js";
import type { PluginParserProfile } from "./types.js";

/**
 * Agent Plugins name rule, byte-for-byte the canonical
 * plugin.schema.json pattern: lowercase alphanumerics plus `-`/`.`, no
 * leading/trailing separator, no `--`, no `..`; 1–64 chars. Note the
 * published pattern DOES accept mixed adjacent separators (`foo.-bar`,
 * `foo-.bar`) — only same-character doubles are excluded — and rejecting
 * them here would reject spec-valid names.
 */
const AP_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** Both rules cap a name at 64 characters. */
export const PLUGIN_NAME_MAX_LENGTH = 64;

/** The portal's `plugin_name_format`. */
export const PORTAL_PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type PluginNameRuleCode = Extract<
  PluginPortalRuleCode,
  `plugin_name_${string}`
>;

/** The portal's `name` rules `value` breaks, in the order its page lists them. */
export function portalPluginNameRefusals(value: unknown): PluginNameRuleCode[] {
  if (value === undefined) return ["plugin_name_missing"];
  if (typeof value !== "string") return ["plugin_name_wrong_type"];
  // The portal reads a whitespace-only value as empty.
  if (value.trim() === "") return ["plugin_name_empty"];
  const refusals: PluginNameRuleCode[] = [];
  if (value.length > PLUGIN_NAME_MAX_LENGTH) {
    refusals.push("plugin_name_too_long");
  }
  if (!PORTAL_PLUGIN_NAME_PATTERN.test(value)) {
    refusals.push("plugin_name_format");
  }
  return refusals;
}

export type PluginNameCheck =
  { ok: true; name: string } | { ok: false; message: string };

const AGENT_PLUGINS_NAME_MESSAGE = `manifest "name" must be 1-${PLUGIN_NAME_MAX_LENGTH} lowercase [a-z0-9.-] chars with single separators (no "--" or "..")`;

/** Whether the parser accepts `value` as a plugin name under `profile`. */
export function checkPluginName(
  value: unknown,
  profile: PluginParserProfile
): PluginNameCheck {
  const [refusal] = portalPluginNameRefusals(value);
  const portal = profile === "openai-compatible";
  if (typeof value === "string") {
    const agentPlugins =
      value.length <= PLUGIN_NAME_MAX_LENGTH && AP_NAME.test(value);
    if (agentPlugins || (portal && refusal === undefined)) {
      return { ok: true, name: value };
    }
  }
  return {
    ok: false,
    message:
      portal && refusal !== undefined
        ? PLUGIN_PORTAL_RULES[refusal].message
        : AGENT_PLUGINS_NAME_MESSAGE,
  };
}
