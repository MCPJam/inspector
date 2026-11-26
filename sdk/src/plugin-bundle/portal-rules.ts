/**
 * The ChatGPT plugin portal's wording for the package rules this parser
 * shares with it.
 *
 * MCPJam accepts the packages the portal accepts, so where the parser refuses
 * one for a rule the portal states, the refusal uses the portal's code and
 * message verbatim. A person can then match MCPJam's answer to the portal's,
 * and the readiness reader reports the words the upload would. Wording only:
 * `plugin-root.ts` and `plugin-name.ts` decide.
 */

/** The page these were copied from, and when. */
export const PLUGIN_PORTAL_RULES_SOURCE = {
  url: "https://developers.openai.com/plugins/deploy/submission-errors",
  capturedOn: "2026-11-13",
} as const;

export interface PluginPortalRule {
  /** The table on the source page that lists the code. */
  table: "Plugin root errors" | "Plugin manifest errors";
  message: string;
}

export const PLUGIN_PORTAL_RULES = {
  plugin_manifest_missing: {
    table: "Plugin manifest errors",
    message:
      "ZIP must contain root `plugin.json` with a supported Agent Plugins schema, `.codex-plugin/plugin.json`, `.agent-plugin/plugin.json`, or `.claude-plugin/plugin.json` at the root or in its single top-level directory.",
  },
  plugin_root_ambiguous: {
    table: "Plugin root errors",
    message:
      "ZIP must contain exactly one plugin root, either at the archive root or in one top-level directory.",
  },
  plugin_root_has_siblings: {
    table: "Plugin root errors",
    message:
      "A ZIP with a top-level plugin directory must not contain sibling files.",
  },
  plugin_name_missing: {
    table: "Plugin manifest errors",
    message: "`name` is required.",
  },
  plugin_name_wrong_type: {
    table: "Plugin manifest errors",
    message: "`name` must be a string.",
  },
  plugin_name_empty: {
    table: "Plugin manifest errors",
    message: "`name` must be non-empty.",
  },
  plugin_name_too_long: {
    table: "Plugin manifest errors",
    message: "`name` must be 64 characters or fewer.",
  },
  plugin_name_format: {
    table: "Plugin manifest errors",
    message:
      "`name` must start with an ASCII letter or digit and contain only ASCII letters, digits, `_`, or `-`.",
  },
} as const satisfies Record<string, PluginPortalRule>;

export type PluginPortalRuleCode = keyof typeof PLUGIN_PORTAL_RULES;
