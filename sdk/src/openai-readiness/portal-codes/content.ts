/**
 * The page's tables for what the package carries: skills, their
 * `agents/openai.yaml`, asset paths, images, and the package warnings.
 *
 * Pure data. Safe from the browser entry.
 */

import {
  BOOLEAN,
  HEX_COLOR,
  NON_EMPTY,
  OBJECT,
  PRESENT,
  STRING,
  TEXT,
  field,
  file,
  matches,
  maxLength,
  portalTable,
} from "./define.js";

const SKILL_FILE = "skills/<skill>/SKILL.md";
const AGENT_FILE = "skills/<skill>/agents/openai.yaml";
const AGENT_NAME = "interface.display_name";
const AGENT_SUMMARY = "interface.short_description";
const ICON_SMALL = "interface.icon_small";
const ICON_LARGE = "interface.icon_large";
const AGENT_COLOR = "interface.brand_color";
const AGENT_PROMPT = "interface.default_prompt";
const IMPLICIT = "policy.allow_implicit_invocation";

/** Skill errors: a skill folder, its `SKILL.md` and its front matter. */
export const SKILL_ERRORS = portalTable({
  table: "Skill errors",
  stage: "upload",
  document: "skill-frontmatter",
  rows: [
    "skill_manifest_missing: Skill must contain a `SKILL.md` file.",
    "skill_bundle_too_large: Each compressed skill bundle must be within the MiB limit reported in the error.",
    "skill_directory_hidden: Skill directory names must not begin with `.`.",
    "skill_manifest_nested: Each skill directory must be an immediate child of `skills/`.",
    "skill_manifest_not_regular_file: `SKILL.md` must be a regular file.",
    "skill_manifest_unreadable: `SKILL.md` must be readable.",
    "skill_manifest_invalid_utf8: `SKILL.md` must contain valid UTF-8.",
    "skill_frontmatter_missing: `SKILL.md` must start with YAML front matter between `---` lines.",
    "skill_frontmatter_unclosed: `SKILL.md` YAML front matter must end with `---`.",
    "skill_frontmatter_yaml_malformed: `SKILL.md` front matter must contain valid YAML.",
    "skill_frontmatter_wrong_type: `SKILL.md` front matter must contain a YAML mapping.",
    "skill_name_missing: `name` is required and must not be empty.",
    "skill_name_wrong_type: `name` must be a string.",
    "skill_name_empty: `name` must be non-empty.",
    "skill_name_character_unsupported: Skill front matter `name` must use supported text.",
    "skill_description_missing: `description` is required and must not be empty.",
    "skill_description_wrong_type: `description` must be a string.",
    "skill_description_empty: `description` must be non-empty.",
    "skill_description_too_long: `description` must be 1,024 characters or fewer.",
    "skill_description_character_unsupported: Skill front matter `description` must use supported text.",
    "skill_body_empty: Skill instructions must not be empty.",
    "skill_identity_too_long: The combined plugin and skill name (`plugin-name:skill-name`) must be 64 characters or fewer.",
    "skill_identity_duplicate: Each skill `name` must be unique within the plugin.",
  ],
  targets: {
    skill_manifest_missing: file(SKILL_FILE),
    skill_manifest_not_regular_file: file(SKILL_FILE),
    skill_manifest_unreadable: file(SKILL_FILE),
    skill_manifest_invalid_utf8: file(SKILL_FILE),
    skill_frontmatter_missing: file(SKILL_FILE),
    skill_frontmatter_unclosed: file(SKILL_FILE),
    skill_frontmatter_yaml_malformed: file(SKILL_FILE),
    skill_frontmatter_wrong_type: file(SKILL_FILE),
    skill_name_missing: field("name", PRESENT),
    skill_name_wrong_type: field("name", STRING),
    skill_name_empty: field("name", NON_EMPTY),
    skill_name_character_unsupported: field("name", TEXT),
    skill_description_missing: field("description", PRESENT),
    skill_description_wrong_type: field("description", STRING),
    skill_description_empty: field("description", NON_EMPTY),
    skill_description_too_long: field("description", maxLength(1024)),
    skill_description_character_unsupported: field("description", TEXT),
    skill_identity_duplicate: field("name"),
  },
});

/** Skill agent metadata errors: `skills/<skill>/agents/openai.yaml`. */
export const SKILL_AGENT_ERRORS = portalTable({
  table: "Skill agent metadata errors",
  stage: "upload",
  document: "skill-agent",
  rows: [
    "skill_agent_not_regular_file: `agents/openai.yaml` must be a regular file.",
    "skill_agent_unreadable: `agents/openai.yaml` must be readable.",
    "skill_agent_invalid_utf8: `agents/openai.yaml` must contain valid UTF-8.",
    "skill_agent_yaml_malformed: `agents/openai.yaml` must contain valid YAML.",
    "skill_agent_top_level_wrong_type: `agents/openai.yaml` must contain a YAML mapping at the top level.",
    "skill_agent_interface_missing: `interface` is required in `agents/openai.yaml` when that file is included.",
    "skill_agent_interface_wrong_type: `interface` in `agents/openai.yaml` must be a YAML mapping.",
    "skill_agent_display_name_missing: `interface.display_name` is required and must not be empty.",
    "skill_agent_display_name_wrong_type: `interface.display_name` must be a string.",
    "skill_agent_display_name_empty: `interface.display_name` must not be empty.",
    "skill_agent_short_description_missing: `interface.short_description` is required and must not be empty.",
    "skill_agent_short_description_wrong_type: `interface.short_description` must be a string.",
    "skill_agent_short_description_empty: `interface.short_description` must not be empty.",
    "skill_agent_icon_small_wrong_type: `interface.icon_small` must be a non-empty relative file path when provided.",
    "skill_agent_icon_small_empty: `interface.icon_small` must be a non-empty relative file path when provided, such as `assets/icon.png`.",
    "skill_agent_icon_large_wrong_type: `interface.icon_large` must be a non-empty relative file path when provided.",
    "skill_agent_icon_large_empty: `interface.icon_large` must be a non-empty relative file path when provided, such as `assets/icon.png`.",
    "skill_agent_brand_color_wrong_type: `interface.brand_color` must be a string when provided.",
    "skill_agent_brand_color_empty: `interface.brand_color` must be a non-empty six-digit hex color when provided, such as `#1ABCFE`.",
    "skill_agent_brand_color_format: `interface.brand_color` must be a six-digit hex color, such as `#1ABCFE`.",
    "skill_agent_default_prompt_wrong_type: `interface.default_prompt` must be a string when provided.",
    "skill_agent_default_prompt_empty: `interface.default_prompt` must be non-empty when provided.",
    "skill_agent_policy_wrong_type: `policy` must be a YAML mapping when provided.",
    "skill_agent_allow_implicit_invocation_wrong_type: `policy` may contain only `products` and `allow_implicit_invocation`. `products` must contain `CHAT`, `CODEX`, or both, and `allow_implicit_invocation` must be `true` or `false`.",
    "skill_agent_dependencies_wrong_type: `dependencies` must be a YAML mapping; only `tools` is supported.",
    "skill_agent_dependency_unsupported: Only `dependencies.tools` is supported in `agents/openai.yaml`.",
  ],
  targets: {
    skill_agent_not_regular_file: file(AGENT_FILE),
    skill_agent_unreadable: file(AGENT_FILE),
    skill_agent_invalid_utf8: file(AGENT_FILE),
    skill_agent_yaml_malformed: file(AGENT_FILE),
    skill_agent_top_level_wrong_type: file(AGENT_FILE),
    skill_agent_interface_missing: field("interface", PRESENT),
    skill_agent_interface_wrong_type: field("interface", OBJECT),
    skill_agent_display_name_missing: field(AGENT_NAME, PRESENT),
    skill_agent_display_name_wrong_type: field(AGENT_NAME, STRING),
    skill_agent_display_name_empty: field(AGENT_NAME, NON_EMPTY),
    skill_agent_short_description_missing: field(AGENT_SUMMARY, PRESENT),
    skill_agent_short_description_wrong_type: field(AGENT_SUMMARY, STRING),
    skill_agent_short_description_empty: field(AGENT_SUMMARY, NON_EMPTY),
    skill_agent_icon_small_wrong_type: field(ICON_SMALL, STRING),
    skill_agent_icon_small_empty: field(ICON_SMALL, NON_EMPTY),
    skill_agent_icon_large_wrong_type: field(ICON_LARGE, STRING),
    skill_agent_icon_large_empty: field(ICON_LARGE, NON_EMPTY),
    skill_agent_brand_color_wrong_type: field(AGENT_COLOR, STRING),
    skill_agent_brand_color_empty: field(AGENT_COLOR, NON_EMPTY),
    skill_agent_brand_color_format: field(AGENT_COLOR, matches(HEX_COLOR)),
    skill_agent_default_prompt_wrong_type: field(AGENT_PROMPT, STRING),
    skill_agent_default_prompt_empty: field(AGENT_PROMPT, NON_EMPTY),
    skill_agent_policy_wrong_type: field("policy", OBJECT),
    skill_agent_allow_implicit_invocation_wrong_type: field(IMPLICIT, BOOLEAN),
    skill_agent_dependencies_wrong_type: field("dependencies", OBJECT),
    skill_agent_dependency_unsupported: field("dependencies"),
  },
});

/** Asset path errors, about whichever asset field names the path. */
export const ASSET_PATH_ERRORS = portalTable({
  table: "Asset path errors",
  stage: "upload",
  rows: [
    "declared_asset_path_wrong_type: The named asset field must be a file path string.",
    "declared_asset_path_empty: The named asset field must not be empty.",
    "declared_asset_path_has_outer_whitespace: The named asset field must not begin or end with whitespace.",
    "declared_asset_path_has_control_character: The named asset field must not contain characters U+0000–U+001F or U+007F.",
    "branding_asset_path_missing_root_prefix: The named asset field must start with `./`.",
    "declared_asset_path_unsafe: The named asset field must be a relative path inside the plugin and must not contain an absolute path, drive prefix, or `..` traversal segment.",
    "declared_asset_path_outside_package: The named asset field must reference a file inside the plugin.",
    "declared_asset_file_missing: The named asset field references a file that does not exist.",
    "declared_asset_not_regular_file: The named asset field must reference a file, not a directory or special file.",
  ],
});

/** Image errors: "These rules apply to packaged branding assets." */
export const IMAGE_ERRORS = portalTable({
  table: "Image errors",
  stage: "upload",
  document: "plugin-manifest",
  rows: [
    "plugin_logo_path_missing: `interface.logo` is required and must reference a square image.",
    "plugin_composer_icon_path_missing: `interface.composerIcon` is required and must reference a square image.",
    "image_file_unreadable: Image file must be readable.",
    "image_file_too_large: Image must not exceed 5 MiB.",
    "image_file_format_unsupported: Image filename must end in `.png`, `.jpg`, `.jpeg`, `.webp`, or `.svg`.",
    "raster_image_decode_failed: Raster image must be a PNG, JPEG, or WebP file that can be decoded safely.",
    "raster_image_extension_content_mismatch: Image filename extension must match the detected image format.",
    "raster_image_not_square: Image must be square.",
    "raster_image_dimensions_too_small: Image dimensions must be at least 48×48 pixels.",
    "raster_image_dimensions_too_large: Image dimensions must not exceed 4,096×4,096 pixels.",
    "svg_xml_malformed: SVG must contain valid UTF-8 XML.",
    "svg_root_element_invalid: SVG root element must be `<svg>`.",
    "svg_dimensions_missing: SVG must define a numeric `viewBox` or numeric `width` and `height`.",
    "svg_dimensions_not_numeric: SVG dimensions must be numeric and omit units and percentages.",
    "svg_dimensions_not_positive: SVG width and height must be positive finite numbers.",
    "svg_dimensions_not_square: SVG dimensions must be square.",
    "svg_dimensions_too_small: SVG dimensions must be at least 48×48 pixels.",
  ],
  targets: {
    plugin_logo_path_missing: field("interface.logo"),
    plugin_composer_icon_path_missing: field("interface.composerIcon"),
  },
});

/** Package warnings: "They don't block submission." */
export const PACKAGE_WARNINGS = portalTable({
  table: "Package warnings",
  stage: "upload",
  severity: "warning",
  rows: [
    "duplicate_app_reference: Each server ID in `.app.json` must be referenced once; duplicate references are treated as one server.",
    "undeclared_app_manifest_ignored: A root `.app.json` is imported only when the plugin-manifest `apps` field is set to `./.app.json`.",
    "undeclared_mcp_manifest_ignored: A root `.mcp.json` is imported only when the plugin-manifest `mcpServers` field is set to `./.mcp.json`.",
    "skill_file_ignored: Files directly under `skills/` aren't imported as skills; each skill must be in a directory containing `SKILL.md`.",
    "skill_symlink_ignored: Symbolic links directly under `skills/` aren't imported as skills; each skill must be a real directory containing `SKILL.md`.",
    "skill_frontmatter_adjusted: Skill `name` and `description` are normalized during import by trimming outer whitespace and collapsing internal whitespace.",
    "skill_metadata_ignored: Skill interface settings must use the `interface` mapping in `agents/openai.yaml`; `metadata` in `SKILL.md` doesn't configure the interface.",
  ],
  targets: {
    duplicate_app_reference: file(".app.json"),
    undeclared_app_manifest_ignored: file(".app.json"),
    undeclared_mcp_manifest_ignored: file(".mcp.json"),
    skill_file_ignored: file("skills/"),
    skill_symlink_ignored: file("skills/"),
    skill_metadata_ignored: file(SKILL_FILE),
  },
});
