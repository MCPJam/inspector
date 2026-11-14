/**
 * The page's "Archive errors" tables and its plugin root errors: what the ZIP
 * upload checks before it reads the manifest.
 *
 * Pure data. Safe from the browser entry.
 */

import { PLUGIN_PORTAL_RULES as PARSER } from "../../plugin-bundle/portal-rules.js";
import { DEVELOPER, field, file, portalTable } from "./define.js";

/**
 * ZIP upload errors and warnings. The page says "Errors block the upload;
 * warnings require confirmation" without marking which is which. The warnings
 * here are the codes that describe what the portal changes or say reuse
 * "requires confirmation"; `plugin_name_mismatch` and
 * `app_configuration_excluded` state a requirement.
 */
export const ZIP_UPLOAD_ERRORS = portalTable({
  table: "ZIP upload errors and warnings",
  stage: "upload",
  document: "plugin-manifest",
  warnings: [
    "plugin_version_unchanged",
    "mcp_configuration_excluded",
    "claude_format_normalized",
    "manifest_normalized",
    "developer_name_defaulted",
  ],
  rows: [
    "plugin_name_mismatch: The package name in an update must match the existing plugin name.",
    "plugin_version_unchanged: A new release must use a different manifest `version`; reusing the published version requires confirmation.",
    "mcp_configuration_excluded: MCP configuration is excluded unless your organization is approved for local MCP submissions. For a local MCP plugin, ask your OpenAI representative to confirm the submitting organization is allowlisted. Submit remote MCP servers through **With MCP**.",
    "app_configuration_excluded: ZIP uploads must not include `apps` or `.app.json`. Submit remote MCP servers through **With MCP**; for local MCP servers, follow the desktop-only submission instructions.",
    "claude_format_normalized: `.claude-plugin/plugin.json` is converted to `.codex-plugin/plugin.json`, with missing interface defaults and normalized text fields added by the portal.",
    "manifest_normalized: The portal saves the normalized manifest as `.codex-plugin/plugin.json`; changed fields require confirmation.",
    "developer_name_defaulted: The listing’s developer name is set automatically from your selected verified developer identity, regardless of the name in your ZIP.",
  ],
  targets: {
    plugin_name_mismatch: field("name"),
    plugin_version_unchanged: field("version"),
    claude_format_normalized: file(".claude-plugin/plugin.json"),
    manifest_normalized: file(".codex-plugin/plugin.json"),
    developer_name_defaulted: field(DEVELOPER),
  },
});

/** ZIP structure and limit errors. */
export const ZIP_STRUCTURE_ERRORS = portalTable({
  table: "ZIP structure and limit errors",
  stage: "upload",
  rows: [
    "archive_empty: Archive must not be empty.",
    "archive_too_large: Compressed ZIP must be 100 MB or less.",
    "archive_format_not_zip: Archive must be a valid, uncorrupted ZIP file.",
    "archive_member_path_empty: Archive entry path must not be empty.",
    "archive_member_path_has_outer_whitespace: Archive entry path must not begin or end with whitespace.",
    "archive_member_path_has_backslash: Archive entry path must use `/`, not backslashes.",
    "archive_member_path_absolute: Archive entry path must be relative to the archive root.",
    "archive_member_path_has_empty_segment: Archive entry path must not contain empty segments.",
    "archive_member_path_has_parent_segment: Archive entry path must not contain `..` segments.",
    "archive_member_path_too_deep: Archive entry path must contain at most 20 segments, including the filename.",
    "archive_member_path_too_long: Archive entry path must be within the supported path-length limit.",
    "archive_member_path_normalization_collision: Archive entry paths must remain unique after case and Unicode normalization.",
    "archive_member_type_unsupported: Archive entries must be regular files or directories.",
    "archive_member_too_large: Archive entry must not exceed 100 MiB.",
    "archive_member_path_duplicate: Archive entry path must be unique.",
    "archive_member_path_type_conflict: A file path cannot also be a directory or contain another archive entry.",
    "archive_too_many_entries: Archive must not contain more than 5,000 entries.",
    "archive_uncompressed_too_large: Extracted archive must not exceed 512 MiB.",
    "archive_member_unreadable: Every archive entry must be readable, must not be encrypted, and must use supported compression.",
  ],
});

/** Plugin root errors. */
export const PLUGIN_ROOT_ERRORS = portalTable({
  table: "Plugin root errors",
  stage: "upload",
  rows: [
    "plugin_root_missing: The selected path must exist and be a directory containing a plugin.",
    "archive_plugin_files_missing: A ZIP must contain a supported plugin manifest and at least one valid skill (or an approved local MCP server).",
    `plugin_root_ambiguous: ${PARSER.plugin_root_ambiguous.message}`,
    `plugin_root_has_siblings: ${PARSER.plugin_root_has_siblings.message}`,
  ],
});
