import type { AppsCheckFeatureMap } from "./types.js";

/** MCP Apps suite check → catalog features (family 19). */
export const APPS_CHECK_FEATURES = {
  "ui-tools-present": ["apps.tool-resource-uri"],
  "ui-tool-metadata-valid": ["apps.tool-resource-uri", "apps.visibility"],
  // A UI tool's input schema is part of a valid tool link; the protocol suite
  // checks input schemas for every tool.
  "ui-tool-input-schema-valid": ["apps.tool-resource-uri"],
  "ui-listed-resources-valid": ["apps.ui-resource"],
  "ui-resources-readable": ["apps.html-content"],
  "ui-resource-contents-valid": ["apps.html-content"],
  "ui-resource-meta-valid": [
    "apps.csp",
    "apps.permissions",
    "apps.domain",
    "apps.prefers-border",
  ],
} as const satisfies AppsCheckFeatureMap;
