/**
 * The page's tables for the plugin manifest and the files it points at:
 * plugin manifest errors, plugin content errors, MCP manifest errors (for
 * `.mcp.json`) and MCP server reference errors (for `.app.json`).
 *
 * Pure data. Safe from the browser entry.
 */

import {
  PLUGIN_NAME_MAX_LENGTH,
  PORTAL_PLUGIN_NAME_PATTERN,
} from "../../plugin-bundle/plugin-name.js";
import { PLUGIN_PORTAL_RULES as PARSER } from "../../plugin-bundle/portal-rules.js";
import {
  BOOLEAN,
  NON_EMPTY,
  OBJECT,
  PRESENT,
  SEMVER,
  STRING,
  TEXT,
  excludes,
  field,
  file,
  matches,
  maxLength,
  portalTable,
} from "./define.js";

/** `author.url` has its own code for credentials, so this one allows them. */
const HTTPS_SCHEME = /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i;
const NO_CREDENTIALS = excludes(/^[a-z][a-z\d+.-]*:\/\/[^\s/?#]*@/i);
// Paths that "resolve to the root" `skills/`, `.app.json` or `.mcp.json`.
const SKILLS_PATH = /^(?:\.\/)?skills\/?$/;
const APPS_PATH = /^(?:\.\/)?\.app\.json$/;
const MCP_PATH = /^(?:\.\/)?\.mcp\.json$/;
const APP_ID = /^(?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9][\w-]*$/;

/** Plugin manifest errors. */
export const PLUGIN_MANIFEST_ERRORS = portalTable({
  table: "Plugin manifest errors",
  stage: "upload",
  document: "plugin-manifest",
  rows: [
    `plugin_manifest_missing: ${PARSER.plugin_manifest_missing.message}`,
    "plugin_manifest_not_file: Plugin manifest must be a regular JSON file.",
    "plugin_manifest_unreadable: Plugin manifest must be readable UTF-8 text.",
    "plugin_manifest_json_malformed: Plugin manifest must contain valid JSON; malformed syntax is reported with a line number.",
    "plugin_manifest_root_not_object: Plugin manifest must contain a JSON object at the top level.",
    "codex_manifest_parent_not_directory: `.codex-plugin` must be a directory.",
    "codex_manifest_path_not_file: `.codex-plugin/plugin.json` must be a regular JSON file.",
    "plugin_id_wrong_type: `id` must be a string when provided.",
    "plugin_id_empty: `id` must be non-empty when provided.",
    `plugin_name_missing: ${PARSER.plugin_name_missing.message}`,
    `plugin_name_wrong_type: ${PARSER.plugin_name_wrong_type.message}`,
    `plugin_name_empty: ${PARSER.plugin_name_empty.message}`,
    `plugin_name_too_long: ${PARSER.plugin_name_too_long.message}`,
    `plugin_name_format: ${PARSER.plugin_name_format.message}`,
    "plugin_version_missing: `version` is required.",
    "plugin_version_wrong_type: `version` must be a string.",
    "plugin_version_empty: `version` must be a non-empty semantic-version string, such as `1.0.0`.",
    "plugin_version_not_semver: `version` must use semantic versioning, such as `1.0.0`.",
    "plugin_version_too_long: `version` must be 64 characters or fewer.",
    "plugin_description_missing: `description` is required.",
    "plugin_description_wrong_type: `description` must be a string.",
    "plugin_description_empty: `description` must be non-empty.",
    "plugin_description_too_long: `description` must be 1,024 characters or fewer.",
    "plugin_description_character_unsupported: `description` must use supported text. Line breaks are allowed.",
    "plugin_developer_missing: `author.name` is required. `interface.developerName` is also required and is reported separately.",
    "plugin_author_wrong_type: `author` must be an object.",
    "plugin_author_name_wrong_type: `author.name` must be a string.",
    "plugin_author_name_empty: `author.name` must be non-empty.",
    "plugin_author_name_too_long: `author.name` must be 120 characters or fewer.",
    "plugin_author_name_character_unsupported: `author.name` must use supported text.",
    "plugin_author_email_wrong_type: `author.email` must be a string when provided.",
    "plugin_author_email_empty: `author.email` must be non-empty when provided.",
    "plugin_author_email_too_long: `author.email` must be 320 characters or fewer.",
    "plugin_author_email_character_unsupported: `author.email` must use supported text.",
    "plugin_author_url_wrong_type: `author.url` must be a string when provided.",
    "plugin_author_url_empty: `author.url` must be non-empty when provided.",
    "plugin_author_url_not_https: `author.url` must be an HTTPS URL.",
    "plugin_author_url_has_credentials: `author.url` must not contain credentials.",
    "plugin_author_url_too_long: `author.url` must be 2,048 characters or fewer.",
    "plugin_author_url_character_unsupported: `author.url` must use supported text.",
  ],
  targets: {
    codex_manifest_parent_not_directory: file(".codex-plugin"),
    codex_manifest_path_not_file: file(".codex-plugin/plugin.json"),
    plugin_id_wrong_type: field("id", STRING),
    plugin_id_empty: field("id", NON_EMPTY),
    plugin_name_missing: field("name", PRESENT),
    plugin_name_wrong_type: field("name", STRING),
    plugin_name_empty: field("name", NON_EMPTY),
    plugin_name_too_long: field("name", maxLength(PLUGIN_NAME_MAX_LENGTH)),
    plugin_name_format: field("name", matches(PORTAL_PLUGIN_NAME_PATTERN)),
    plugin_version_missing: field("version", PRESENT),
    plugin_version_wrong_type: field("version", STRING),
    plugin_version_empty: field("version", NON_EMPTY),
    plugin_version_not_semver: field("version", matches(SEMVER)),
    plugin_version_too_long: field("version", maxLength(64)),
    plugin_description_missing: field("description", PRESENT),
    plugin_description_wrong_type: field("description", STRING),
    plugin_description_empty: field("description", NON_EMPTY),
    plugin_description_too_long: field("description", maxLength(1024)),
    plugin_description_character_unsupported: field("description", TEXT),
    plugin_developer_missing: field("author.name", PRESENT),
    plugin_author_wrong_type: field("author", OBJECT),
    plugin_author_name_wrong_type: field("author.name", STRING),
    plugin_author_name_empty: field("author.name", NON_EMPTY),
    plugin_author_name_too_long: field("author.name", maxLength(120)),
    plugin_author_name_character_unsupported: field("author.name", TEXT),
    plugin_author_email_wrong_type: field("author.email", STRING),
    plugin_author_email_empty: field("author.email", NON_EMPTY),
    plugin_author_email_too_long: field("author.email", maxLength(320)),
    plugin_author_email_character_unsupported: field("author.email", TEXT),
    plugin_author_url_wrong_type: field("author.url", STRING),
    plugin_author_url_empty: field("author.url", NON_EMPTY),
    plugin_author_url_not_https: field("author.url", matches(HTTPS_SCHEME)),
    plugin_author_url_has_credentials: field("author.url", NO_CREDENTIALS),
    plugin_author_url_too_long: field("author.url", maxLength(2048)),
    plugin_author_url_character_unsupported: field("author.url", TEXT),
  },
});

/** Plugin content errors: the paths a Codex manifest declares. */
export const PLUGIN_CONTENT_ERRORS = portalTable({
  table: "Plugin content errors",
  stage: "upload",
  document: "plugin-manifest",
  rows: [
    "plugin_skills_path_wrong_type: `skills` must be a string path for the root `skills/` directory.",
    "plugin_skills_path_empty: `skills` must be a non-empty path to the root `skills/` directory when provided.",
    "plugin_skills_path_unsupported: `skills` must resolve to the root `skills/` directory.",
    "plugin_skills_directory_missing: A declared root `skills/` directory must exist.",
    "plugin_skills_path_not_directory: Root `skills/` must be a directory when declared.",
    "plugin_apps_path_wrong_type: `apps` must be a string path for the root `.app.json`.",
    "plugin_apps_path_empty: `apps` must be a non-empty path to the root `.app.json` when provided.",
    "plugin_apps_path_unsupported: `apps` must resolve to the root `.app.json`.",
    "plugin_apps_file_missing: A declared root `.app.json` file must exist.",
    "plugin_apps_path_not_file: Root `.app.json` must be a regular file when declared.",
    "plugin_mcp_path_wrong_type: `mcpServers` must be a string path for the root `.mcp.json`.",
    "plugin_mcp_path_empty: `mcpServers` must be a nonempty path. Set it to `./.mcp.json` or remove the field.",
    "plugin_mcp_path_unsupported: `mcpServers` must resolve to the root `.mcp.json`.",
    "plugin_mcp_file_missing: `mcpServers` declares the root `.mcp.json`, but that file doesn't exist.",
    "plugin_mcp_path_not_file: Root `.mcp.json` must be a regular file.",
    "plugin_runtime_surface_missing: A public submission ZIP must contain at least one valid skill (or an approved local MCP server). Local and workspace packages can also reference an eligible MCP server.",
  ],
  targets: {
    plugin_skills_path_wrong_type: field("skills", STRING),
    plugin_skills_path_empty: field("skills", NON_EMPTY),
    plugin_skills_path_unsupported: field("skills", matches(SKILLS_PATH)),
    plugin_skills_directory_missing: file("skills/"),
    plugin_skills_path_not_directory: file("skills/"),
    plugin_apps_path_wrong_type: field("apps", STRING),
    plugin_apps_path_empty: field("apps", NON_EMPTY),
    plugin_apps_path_unsupported: field("apps", matches(APPS_PATH)),
    plugin_apps_file_missing: file(".app.json"),
    plugin_apps_path_not_file: file(".app.json"),
    plugin_mcp_path_wrong_type: field("mcpServers", STRING),
    plugin_mcp_path_empty: field("mcpServers", NON_EMPTY),
    plugin_mcp_path_unsupported: field("mcpServers", matches(MCP_PATH)),
    plugin_mcp_file_missing: file(".mcp.json"),
    plugin_mcp_path_not_file: file(".mcp.json"),
  },
});

/**
 * MCP manifest errors. For a portable package the portal derives `.mcp.json`
 * from `mcp.json`, so these name the derived file.
 */
export const MCP_MANIFEST_ERRORS = portalTable({
  table: "MCP manifest errors",
  stage: "upload",
  document: "mcp-config",
  rows: [
    "mcp_manifest_unreadable: `.mcp.json` must be readable UTF-8 text.",
    "mcp_manifest_json_malformed: `.mcp.json` must contain valid JSON; malformed syntax is reported with a line number.",
    "mcp_manifest_wrong_type: `.mcp.json` must contain a JSON object at the top level.",
    "mcp_servers_missing: `.mcp.json` must contain the top-level `mcpServers` field.",
    "mcp_servers_wrong_type: `mcpServers` must be an object.",
    "mcp_server_name_empty: Every MCP server name must contain at least one non-whitespace character.",
    "mcp_server_wrong_type: Each `mcpServers.<server-name>` value must be an object containing that server's declaration.",
  ],
  targets: {
    mcp_manifest_unreadable: file(".mcp.json"),
    mcp_manifest_json_malformed: file(".mcp.json"),
    mcp_manifest_wrong_type: file(".mcp.json"),
    mcp_servers_missing: field("mcpServers", PRESENT),
    mcp_servers_wrong_type: field("mcpServers", OBJECT),
    mcp_server_name_empty: field("mcpServers"),
    mcp_server_wrong_type: field("mcpServers.*", OBJECT),
  },
});

/**
 * MCP server reference errors: `.app.json`, which "A **Skills only** upload
 * removes", so these reach local and workspace packages.
 */
export const MCP_SERVER_REFERENCE_ERRORS = portalTable({
  table: "MCP server reference errors",
  stage: "upload",
  document: "app-config",
  rows: [
    "app_manifest_unreadable: `.app.json` must be readable UTF-8 text.",
    "app_manifest_json_malformed: `.app.json` contains malformed JSON near the reported line.",
    "app_manifest_wrong_type: `.app.json` must contain a JSON object at the top level.",
    "app_entries_missing: `apps` is required.",
    "app_entries_wrong_type: `apps` must be an object.",
    "app_entry_wrong_type: Each server entry must be an object.",
    "app_id_missing: Each server entry's `id` is required.",
    "app_id_wrong_type: Each server entry's `id` must be a string.",
    "app_id_format: Each server entry's `id` must begin with `asdk_app_`, `connector_`, or `templated_apps_`, followed by a letter or digit and then only letters, digits, `_`, or `-`.",
    "app_entry_optional_wrong_type: Each server entry's `optional` value must be `true` or `false` when provided.",
    "app_entry_required_wrong_type: Each server entry's `required` value must be `true` or `false` when provided.",
    "app_not_eligible: A local or workspace package must reference an eligible, available MCP server. Directory submissions must use **With MCP** and submit the MCP server directly.",
  ],
  targets: {
    app_manifest_unreadable: file(".app.json"),
    app_manifest_json_malformed: file(".app.json"),
    app_manifest_wrong_type: file(".app.json"),
    app_entries_missing: field("apps", PRESENT),
    app_entries_wrong_type: field("apps", OBJECT),
    app_entry_wrong_type: field("apps.*", OBJECT),
    app_id_missing: field("apps.*.id", PRESENT),
    app_id_wrong_type: field("apps.*.id", STRING),
    app_id_format: field("apps.*.id", matches(APP_ID)),
    app_entry_optional_wrong_type: field("apps.*.optional", BOOLEAN),
    app_entry_required_wrong_type: field("apps.*.required", BOOLEAN),
  },
});
