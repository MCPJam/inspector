/**
 * MCPJam's own OpenAI issue ids and check ids, matched to the portal code
 * whose rule each one grades, so a result can be set beside what the portal
 * says.
 *
 * An issue id maps to the code that states the same rule about the same field
 * or file, even where MCPJam's limit or reach differs (noted where it does),
 * and to `null` where the page lists no code for the rule. The ids stay until
 * the checks raise the codes themselves.
 *
 * Pure data. Safe from the browser entry.
 */

import type { OpenAIReadinessFinding } from "../types.js";
import { isOpenAIPortalCode, type OpenAIPortalCode } from "./table.js";

export const OPENAI_ISSUE_PORTAL_CODES: Readonly<
  Record<string, OpenAIPortalCode | null>
> = {
  "archive-too-large": "archive_too_large",
  "archive-expands-too-large": "archive_uncompressed_too_large",
  "archive-too-many-entries": "archive_too_many_entries",
  "archive-encrypted-entry": "archive_member_unreadable",
  "archive-path-traversal": "archive_member_path_has_parent_segment",
  "archive-absolute-path": "archive_member_path_absolute",
  "archive-backslash-path": "archive_member_path_has_backslash",
  // MCPJam also refuses a `.` segment, which the page does not mention.
  "archive-empty-path-segment": "archive_member_path_has_empty_segment",
  // MCPJam checks each segment's ends; the portal, the whole path's.
  "archive-path-whitespace": "archive_member_path_has_outer_whitespace",
  "archive-path-control-character": null,
  // Raised for an exact duplicate too: `archive_member_path_duplicate`.
  "archive-duplicate-path": "archive_member_path_normalization_collision",
  "archive-symlink-entry": "archive_member_type_unsupported",

  "manifest-missing": "plugin_manifest_missing",
  // Raised for an unreadable manifest and a non-object too, which have codes.
  "manifest-invalid-json": "plugin_manifest_json_malformed",
  "manifest-name-missing": "plugin_name_missing",
  "manifest-name-too-long": "plugin_name_too_long",
  "manifest-version-invalid": "plugin_version_not_semver",
  // These and `asset-missing` grade an `agents/openai.yaml` at the plugin
  // root; the portal reads that file only inside a skill.
  "interface-display-name-missing": "skill_agent_display_name_missing",
  "interface-display-name-too-long": null,
  "interface-short-description-too-long": null,
  "interface-default-prompt-too-long": null,
  "interface-brand-color-invalid": "skill_agent_brand_color_format",
  "interface-brand-color-low-contrast": null,
  "interface-yaml-invalid": "skill_agent_yaml_malformed",
  "interface-unsupported-text": null,

  "skill-metadata-missing": "skill_manifest_missing",
  // Raised for an unreadable SKILL.md or no front matter too, which have codes.
  "skill-frontmatter-invalid": "skill_frontmatter_yaml_malformed",
  "skill-name-missing": "skill_name_missing",
  // The portal caps `plugin-name:skill-name`, which a long skill name breaks.
  "skill-name-too-long": "skill_identity_too_long",
  "skill-description-missing": "skill_description_missing",
  "skill-name-collision": "skill_identity_duplicate",

  // MCPJam grades every image in the package; the portal, branding images.
  "asset-unsupported-type": "image_file_format_unsupported",
  "asset-too-large": "image_file_too_large",
  // For an SVG the codes are `svg_dimensions_too_small` and
  // `svg_dimensions_not_square`; the page sets no SVG maximum.
  "asset-too-small": "raster_image_dimensions_too_small",
  "asset-too-big-dimensions": "raster_image_dimensions_too_large",
  "asset-not-square": "raster_image_not_square",
  // Raised for an unreadable file too: `image_file_unreadable`.
  "asset-undecodable": "raster_image_decode_failed",
  // Raised for a root that is not `<svg>` too: `svg_root_element_invalid`.
  "asset-svg-malformed": "svg_xml_malformed",
  "asset-svg-no-dimensions": "svg_dimensions_missing",
  "asset-missing": "declared_asset_file_missing",

  "listing-category-unknown": "plugin_category_unknown",
  "listing-description-too-long": "submission_description_too_long",
  "listing-promotional-metadata": null,
  "listing-privacy-policy-missing": null,
  "listing-support-url-missing": null,

  "mcp-endpoint-not-https": null,
  "mcp-endpoint-unreachable": null,
  "mcp-tool-name-too-long": null,
  "mcp-tool-description-missing": null,
  "mcp-tool-annotations-missing": "annotations_required",
  "mcp-tool-schema-invalid": null,
  "mcp-domain-not-verified": "domain_verification_required",
  "mcp-csp-domain-missing": null,
  "mcp-ui-domain-missing": null,
  "mcp-ui-domain-duplicate": null,
  "mcp-ui-mime-invalid": null,

  // The page has no codes for skills imported from an MCP server.
  "mcp-skill-too-many": null,
  "mcp-skill-markdown-too-large": null,
  "mcp-skill-page-too-large": null,
  "mcp-skill-too-many-pages": null,
  "mcp-skill-total-too-large": null,
  "mcp-skills-total-too-large": null,
  "mcp-skill-digest-mismatch": null,
  "mcp-skill-frontmatter-mismatch": null,
  "mcp-skill-scan-failed": null,

  // The page requires most review materials without listing a code for them.
  "review-success-tests-missing": null,
  "review-failure-tests-missing": null,
  "review-demo-credentials-missing": null,
  "review-demo-recording-missing": null,
  "review-release-notes-missing": null,
  "review-attestation-missing": null,
  "review-identity-not-verified": null,
  "review-write-permission-missing": null,
  "review-geography-missing": null,
  "review-annotation-justification-missing": "justification_required",
  "review-scan-stale": "scan_required",

  "exclusion-mcp-servers-in-skills-only": "mcp_configuration_excluded",
  "exclusion-app-config-in-public-package": "app_configuration_excluded",
  "exclusion-screenshots-without-ui": null,
  "exclusion-bundle-in-mcp-only": null,
  "exclusion-unsupported-surface": null,
};

/**
 * Checks that grade a single portal code. Their findings carry it as
 * `details.portalCode`; findings that group issues carry one per issue.
 */
export const OPENAI_CHECK_PORTAL_CODES: Readonly<
  Record<string, OpenAIPortalCode>
> = {
  "openai.tools.annotations": "annotations_required",
  "openai.submission.annotation-justifications": "justification_required",
  "openai.submission.scan-currency": "scan_required",
  "openai.submission.domain-token": "domain_verification_required",
  "openai.domain.challenge-served": "domain_verification_required",
  "openai.domain.challenge-matches": "domain_verification_required",
  "openai.submission.frame-domain-explanations":
    "frame_domain_explanation_required",
};

/** The portal code an issue reports: its own id, or the id's match. */
export function openaiIssuePortalCode(
  id: string
): OpenAIPortalCode | undefined {
  if (isOpenAIPortalCode(id)) return id;
  return OPENAI_ISSUE_PORTAL_CODES[id] ?? undefined;
}

/** The finding, with `details.portalCode` when its check grades one code. */
export function withPortalCode(
  finding: OpenAIReadinessFinding
): OpenAIReadinessFinding {
  const portalCode = OPENAI_CHECK_PORTAL_CODES[finding.id];
  return portalCode
    ? { ...finding, details: { ...finding.details, portalCode } }
    : finding;
}
