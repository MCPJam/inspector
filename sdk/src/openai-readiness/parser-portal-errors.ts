/**
 * Catalog entries for the portal rules the package parser enforces
 * (`plugin-bundle/plugin-root.ts`, `plugin-name.ts`), keyed by the portal's
 * code and in its wording, so a finding reads as the portal's would. Their
 * snapshot date is when that wording was copied.
 *
 * Pure data. Safe from the browser entry.
 */

import {
  PLUGIN_PORTAL_RULES,
  PLUGIN_PORTAL_RULES_SOURCE,
  type PluginPortalRuleCode,
} from "../plugin-bundle/portal-rules.js";
import { openaiPolicySource } from "./manifest.js";
import type {
  OpenAIPortalErrorCategory,
  OpenAIPortalErrorDefinition,
} from "./portal-errors.js";
import { OPENAI_FIELD_LIMITS } from "./profile.js";

/** The finding each code is grouped under. */
const CATEGORIES: Record<PluginPortalRuleCode, OpenAIPortalErrorCategory> = {
  plugin_root_ambiguous: "package-archive",
  plugin_root_has_siblings: "package-archive",
  plugin_manifest_missing: "package-manifest",
  plugin_name_missing: "package-manifest",
  plugin_name_wrong_type: "package-manifest",
  plugin_name_empty: "package-manifest",
  plugin_name_too_long: "package-manifest",
  plugin_name_format: "package-manifest",
};

export const OPENAI_PARSER_PORTAL_ERRORS: readonly OpenAIPortalErrorDefinition[] =
  Object.entries(CATEGORIES).map(([id, category]) => {
    const rule = PLUGIN_PORTAL_RULES[id as PluginPortalRuleCode];
    return {
      id,
      category,
      severity: "blocking",
      message: rule.message,
      ...(id === "plugin_name_too_long"
        ? {
            limit: {
              name: "fieldLimits.pluginNameMaxLength",
              value: OPENAI_FIELD_LIMITS.pluginNameMaxLength,
            },
          }
        : {}),
      source: {
        ...openaiPolicySource("deploy/submission-errors", `§${rule.table}`),
        snapshotDate: PLUGIN_PORTAL_RULES_SOURCE.capturedOn,
      },
    };
  });
