/**
 * The portal's codes as catalog entries, so a check can raise one by its code
 * and a finding reads as the portal's would. Message, severity and source are
 * the code table's; the category is the finding they are grouped under.
 *
 * Pure data. Safe from the browser entry.
 */

import { openaiPolicySource } from "./manifest.js";
import type {
  OpenAIPortalErrorCategory,
  OpenAIPortalErrorDefinition,
} from "./portal-errors.js";
import type { OpenAIPortalCodeTable } from "./portal-codes/define.js";
import {
  OPENAI_PORTAL_CODES,
  type OpenAIPortalCode,
} from "./portal-codes/table.js";
import { OPENAI_FIELD_LIMITS } from "./profile.js";

const CATEGORIES: Record<OpenAIPortalCodeTable, OpenAIPortalErrorCategory> = {
  "Final metadata errors": "listing-fields",
  "MCP and review errors": "mcp-server",
  "ZIP upload errors and warnings": "package-archive",
  "ZIP structure and limit errors": "package-archive",
  "Plugin root errors": "package-archive",
  "Plugin manifest errors": "package-manifest",
  "Listing and interface errors": "package-manifest",
  "Plugin content errors": "package-manifest",
  "MCP manifest errors": "package-manifest",
  "Skill errors": "package-skills",
  "Skill agent metadata errors": "package-skills",
  "Asset path errors": "package-assets",
  "Image errors": "package-assets",
  "MCP server reference errors": "package-manifest",
  "Package warnings": "package-manifest",
};

/** Codes whose table mixes subjects. */
const CATEGORY_OF_CODE: Partial<
  Record<OpenAIPortalCode, OpenAIPortalErrorCategory>
> = {
  mcp_configuration_excluded: "exclusions",
  app_configuration_excluded: "exclusions",
  skill_file_ignored: "package-skills",
  skill_symlink_ignored: "package-skills",
  skill_frontmatter_adjusted: "package-skills",
  skill_metadata_ignored: "package-skills",
};

export const OPENAI_PORTAL_CODE_ERRORS: readonly OpenAIPortalErrorDefinition[] =
  OPENAI_PORTAL_CODES.map((definition) => ({
    id: definition.code,
    category: CATEGORY_OF_CODE[definition.code] ?? CATEGORIES[definition.table],
    severity: definition.severity === "warning" ? "advisory" : "blocking",
    message: definition.message,
    ...(definition.code === "plugin_name_too_long"
      ? {
          limit: {
            name: "fieldLimits.pluginNameMaxLength",
            value: OPENAI_FIELD_LIMITS.pluginNameMaxLength,
          },
        }
      : {}),
    source: {
      ...openaiPolicySource("deploy/submission-errors", `§${definition.table}`),
      snapshotDate: definition.source.capturedOn,
    },
  }));
