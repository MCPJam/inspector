/**
 * The submission portal's error catalog, typed.
 *
 * WHAT THIS IS. A transcription of the documented submission errors: one entry
 * per code, carrying the category it belongs to, whether it blocks a
 * submission, the limit it is enforcing (as a REFERENCE to `profile.ts`, never
 * a restated number), and where in the docs it is defined. Checks reference
 * catalog entries; findings GROUP them for presentation only, in
 * `details.portalIssues`. That split is the point: a reader wants five readable
 * findings, and an auditor wants every documented code preserved with nothing
 * collapsed away.
 *
 * WHAT THIS IS NOT. The portal's validator, or a prediction of its verdict.
 * The submission-errors page is an error CATALOG — the list of things the
 * portal can say — not the source the portal validates from. This module lets a
 * local preflight speak the portal's vocabulary when it finds a problem it can
 * see for itself. It cannot tell anyone their submission will pass, and no
 * finding built on it should imply otherwise.
 *
 * ON COMPLETENESS. The catalog is a transcription, so it is only as complete as
 * the page it was transcribed from at {@link OPENAI_POLICY_SNAPSHOT_DATE}. The
 * policy-drift job is what makes that honest over time: when
 * `deploy/submission-errors` moves, the run fails and this file is re-read.
 *
 * Pure data. Safe from the browser entry.
 */

import { openaiPolicySource, type OpenAIPolicySourceRef } from "./manifest.js";
import {
  OPENAI_ARCHIVE_LIMITS,
  OPENAI_FIELD_LIMITS,
  OPENAI_IMAGE_CONSTRAINTS,
  OPENAI_MCP_SKILL_LIMITS,
  OPENAI_SUBMISSION_TEST_CASES,
} from "./profile.js";

/**
 * The families of check the portal runs.
 *
 * Grouping exists so a finding can say "your archive has four problems" rather
 * than raising four findings; it carries no grading weight of its own.
 */
export const OPENAI_PORTAL_ERROR_CATEGORIES = [
  /** Shape of the uploaded `.zip` itself: size, entry count, path safety. */
  "package-archive",
  /** `plugin.json` and the OpenAI interface document. */
  "package-manifest",
  /** Skill folders, their frontmatter, and their metadata. */
  "package-skills",
  /** Icons and screenshots: type, dimensions, weight. */
  "package-assets",
  /** Listing fields on the submission form. */
  "listing-fields",
  /** Tools, schemas, annotations and auth on the MCP server. */
  "mcp-server",
  /** Skills imported from the MCP server rather than uploaded. */
  "mcp-skills",
  /** Review materials: tests, credentials, recordings, attestations. */
  "review-materials",
  /** Content that is present but excluded in the submitted shape. */
  "exclusions",
] as const;

export type OpenAIPortalErrorCategory =
  (typeof OPENAI_PORTAL_ERROR_CATEGORIES)[number];

/**
 * Whether the portal treats the code as blocking.
 *
 * `blocking` stops the submission; `advisory` is surfaced without stopping it.
 * The distinction is the portal's, not ours — a preflight that promoted an
 * advisory to a blocker would send a submitter to fix something nobody asked
 * them to fix.
 */
export type OpenAIPortalErrorSeverity = "blocking" | "advisory";

export interface OpenAIPortalErrorDefinition {
  /** Stable id used in `details.portalIssues` and in check evidence. */
  id: string;
  category: OpenAIPortalErrorCategory;
  severity: OpenAIPortalErrorSeverity;
  /** One line, in the portal's own terms, describing what tripped. */
  message: string;
  /**
   * The constant this code enforces, when it enforces one.
   *
   * A REFERENCE, so the catalog and the profile cannot disagree: the unit test
   * over this module asserts every numeric limit named here is the identical
   * value exported from `profile.ts`, and that no limit is restated as a
   * literal.
   */
  limit?: { name: string; value: number };
  /** Where the requirement is stated. */
  source: OpenAIPolicySourceRef;
}

const errorsPage = (section: string) =>
  openaiPolicySource("deploy/submission-errors", section);

/**
 * Every documented submission error, by id.
 *
 * Deliberately a flat array rather than a nested tree: presentation groups
 * these, and a tree here would bake one grouping into the data and make a
 * second one impossible.
 */
export const OPENAI_PORTAL_ERRORS: readonly OpenAIPortalErrorDefinition[] = [
  // ---------------------------------------------------------------- archive
  {
    id: "archive-too-large",
    category: "package-archive",
    severity: "blocking",
    message: "The uploaded archive exceeds the maximum compressed size.",
    limit: {
      name: "archiveLimits.maxCompressedBytes",
      value: OPENAI_ARCHIVE_LIMITS.maxCompressedBytes,
    },
    source: errorsPage("§Shared package checks → Archive size"),
  },
  {
    id: "archive-expands-too-large",
    category: "package-archive",
    severity: "blocking",
    message:
      "The archive's contents exceed the maximum uncompressed size when expanded.",
    limit: {
      name: "archiveLimits.maxUncompressedBytes",
      value: OPENAI_ARCHIVE_LIMITS.maxUncompressedBytes,
    },
    source: errorsPage("§Shared package checks → Archive size"),
  },
  {
    id: "archive-too-many-entries",
    category: "package-archive",
    severity: "blocking",
    message: "The archive contains more entries than the maximum allowed.",
    limit: {
      name: "archiveLimits.maxEntries",
      value: OPENAI_ARCHIVE_LIMITS.maxEntries,
    },
    source: errorsPage("§Shared package checks → Entry count"),
  },
  {
    id: "archive-encrypted-entry",
    category: "package-archive",
    severity: "blocking",
    message:
      "The archive contains an encrypted entry, which cannot be scanned.",
    source: errorsPage("§Shared package checks → Archive integrity"),
  },
  {
    id: "archive-path-traversal",
    category: "package-archive",
    severity: "blocking",
    message: "An entry path escapes the package root via a `..` segment.",
    source: errorsPage("§Shared package checks → Entry paths"),
  },
  {
    id: "archive-absolute-path",
    category: "package-archive",
    severity: "blocking",
    message: "An entry path is absolute rather than package-relative.",
    source: errorsPage("§Shared package checks → Entry paths"),
  },
  {
    id: "archive-backslash-path",
    category: "package-archive",
    severity: "blocking",
    message: "An entry path uses a backslash separator.",
    source: errorsPage("§Shared package checks → Entry paths"),
  },
  {
    id: "archive-empty-path-segment",
    category: "package-archive",
    severity: "blocking",
    message: "An entry path contains an empty or `.` segment.",
    source: errorsPage("§Shared package checks → Entry paths"),
  },
  {
    id: "archive-path-whitespace",
    category: "package-archive",
    severity: "blocking",
    message: "An entry path has leading or trailing whitespace.",
    source: errorsPage("§Shared package checks → Entry paths"),
  },
  {
    id: "archive-path-control-character",
    category: "package-archive",
    severity: "blocking",
    message: "An entry path contains a control character or NUL byte.",
    source: errorsPage("§Shared package checks → Entry paths"),
  },
  {
    id: "archive-duplicate-path",
    category: "package-archive",
    severity: "blocking",
    message:
      "Two entries normalize to the same path, including case-insensitive collisions.",
    source: errorsPage("§Shared package checks → Entry paths"),
  },
  {
    id: "archive-symlink-entry",
    category: "package-archive",
    severity: "blocking",
    message: "The archive contains a symlink or hardlink entry.",
    source: errorsPage("§Shared package checks → Archive integrity"),
  },

  // --------------------------------------------------------------- manifest
  {
    id: "manifest-missing",
    category: "package-manifest",
    severity: "blocking",
    message: "The package contains no plugin manifest.",
    source: errorsPage("§Shared package checks → Manifest"),
  },
  {
    id: "manifest-invalid-json",
    category: "package-manifest",
    severity: "blocking",
    message: "The plugin manifest is not valid JSON.",
    source: errorsPage("§Shared package checks → Manifest"),
  },
  {
    id: "manifest-name-missing",
    category: "package-manifest",
    severity: "blocking",
    message: "The manifest declares no plugin name.",
    source: errorsPage("§Shared package checks → Manifest"),
  },
  {
    id: "manifest-name-too-long",
    category: "package-manifest",
    severity: "blocking",
    message: "The manifest's plugin name exceeds the maximum length.",
    limit: {
      name: "fieldLimits.nameMaxLength",
      value: OPENAI_FIELD_LIMITS.nameMaxLength,
    },
    source: errorsPage("§Shared package checks → Manifest"),
  },
  {
    id: "manifest-version-invalid",
    category: "package-manifest",
    severity: "blocking",
    message: "The manifest's version is not a valid semantic version.",
    source: errorsPage("§Shared package checks → Manifest"),
  },
  {
    id: "interface-display-name-missing",
    category: "package-manifest",
    severity: "blocking",
    message: "The OpenAI interface document declares no display name.",
    source: errorsPage("§Listing fields → Interface"),
  },
  {
    id: "interface-display-name-too-long",
    category: "package-manifest",
    severity: "blocking",
    message: "The interface display name exceeds the maximum length.",
    limit: {
      name: "fieldLimits.displayNameMaxLength",
      value: OPENAI_FIELD_LIMITS.displayNameMaxLength,
    },
    source: errorsPage("§Listing fields → Interface"),
  },
  {
    id: "interface-short-description-too-long",
    category: "package-manifest",
    severity: "blocking",
    message: "The interface short description exceeds the maximum length.",
    limit: {
      name: "fieldLimits.shortDescriptionMaxLength",
      value: OPENAI_FIELD_LIMITS.shortDescriptionMaxLength,
    },
    source: errorsPage("§Listing fields → Interface"),
  },
  {
    id: "interface-default-prompt-too-long",
    category: "package-manifest",
    severity: "blocking",
    message: "The interface default prompt exceeds the maximum length.",
    limit: {
      name: "fieldLimits.defaultPromptMaxLength",
      value: OPENAI_FIELD_LIMITS.defaultPromptMaxLength,
    },
    source: errorsPage("§Listing fields → Interface"),
  },
  {
    id: "interface-brand-color-invalid",
    category: "package-manifest",
    severity: "blocking",
    message: "The brand color is not a six-digit hex value.",
    source: errorsPage("§Listing fields → Interface"),
  },
  {
    id: "interface-brand-color-low-contrast",
    category: "package-manifest",
    severity: "blocking",
    message:
      "The brand color does not meet the minimum contrast ratio against both the light and dark backgrounds.",
    source: errorsPage("§Listing fields → Interface"),
  },
  {
    id: "interface-yaml-invalid",
    category: "package-manifest",
    severity: "blocking",
    message: "The OpenAI interface document is not valid YAML.",
    source: errorsPage("§Listing fields → Interface"),
  },
  {
    id: "interface-unsupported-text",
    category: "package-manifest",
    severity: "blocking",
    message:
      "A text field contains control characters or Unicode line/paragraph separators.",
    source: errorsPage("§Listing fields → Text"),
  },

  // ----------------------------------------------------------------- skills
  {
    id: "skill-metadata-missing",
    category: "package-skills",
    severity: "blocking",
    message: "A skill directory contains no SKILL.md.",
    source: errorsPage("§Skills → Structure"),
  },
  {
    id: "skill-frontmatter-invalid",
    category: "package-skills",
    severity: "blocking",
    message: "A skill's SKILL.md frontmatter is missing or malformed.",
    source: errorsPage("§Skills → Frontmatter"),
  },
  {
    id: "skill-name-missing",
    category: "package-skills",
    severity: "blocking",
    message: "A skill's frontmatter declares no name.",
    source: errorsPage("§Skills → Frontmatter"),
  },
  {
    id: "skill-name-too-long",
    category: "package-skills",
    severity: "blocking",
    message: "A skill name exceeds the maximum length.",
    limit: {
      name: "fieldLimits.skillNameMaxLength",
      value: OPENAI_FIELD_LIMITS.skillNameMaxLength,
    },
    source: errorsPage("§Skills → Frontmatter"),
  },
  {
    id: "skill-description-missing",
    category: "package-skills",
    severity: "blocking",
    message: "A skill's frontmatter declares no description.",
    source: errorsPage("§Skills → Frontmatter"),
  },
  {
    id: "skill-name-collision",
    category: "package-skills",
    severity: "blocking",
    message: "Two skills in the package declare the same name.",
    source: errorsPage("§Skills → Structure"),
  },

  // ----------------------------------------------------------------- assets
  {
    id: "asset-unsupported-type",
    category: "package-assets",
    severity: "blocking",
    message: "An image is not one of the accepted formats.",
    source: errorsPage("§Images → Format"),
  },
  {
    id: "asset-too-large",
    category: "package-assets",
    severity: "blocking",
    message: "An image exceeds the maximum file size.",
    limit: {
      name: "imageConstraints.maxBytes",
      value: OPENAI_IMAGE_CONSTRAINTS.maxBytes,
    },
    source: errorsPage("§Images → Size"),
  },
  {
    id: "asset-too-small",
    category: "package-assets",
    severity: "blocking",
    message: "An image is smaller than the minimum edge length.",
    limit: {
      name: "imageConstraints.minEdgePx",
      value: OPENAI_IMAGE_CONSTRAINTS.minEdgePx,
    },
    source: errorsPage("§Images → Dimensions"),
  },
  {
    id: "asset-too-big-dimensions",
    category: "package-assets",
    severity: "blocking",
    message: "An image exceeds the maximum edge length.",
    limit: {
      name: "imageConstraints.maxEdgePx",
      value: OPENAI_IMAGE_CONSTRAINTS.maxEdgePx,
    },
    source: errorsPage("§Images → Dimensions"),
  },
  {
    id: "asset-not-square",
    category: "package-assets",
    severity: "blocking",
    message: "An image is not square.",
    source: errorsPage("§Images → Dimensions"),
  },
  {
    id: "asset-undecodable",
    category: "package-assets",
    severity: "blocking",
    message: "An image's dimensions could not be read from its bytes.",
    source: errorsPage("§Images → Format"),
  },
  {
    id: "asset-svg-malformed",
    category: "package-assets",
    severity: "blocking",
    message: "An SVG is not well-formed XML or has no `svg` root element.",
    source: errorsPage("§Images → SVG"),
  },
  {
    id: "asset-svg-no-dimensions",
    category: "package-assets",
    severity: "blocking",
    message:
      "An SVG declares neither a numeric width/height pair nor a numeric viewBox.",
    source: errorsPage("§Images → SVG"),
  },
  {
    id: "asset-missing",
    category: "package-assets",
    severity: "blocking",
    message: "An asset referenced by the manifest is absent from the package.",
    source: errorsPage("§Images → Format"),
  },

  // ---------------------------------------------------------- listing fields
  {
    id: "listing-category-unknown",
    category: "listing-fields",
    severity: "blocking",
    message: "The listing names a category outside the supported set.",
    source: errorsPage("§Listing fields → Categories"),
  },
  {
    id: "listing-description-too-long",
    category: "listing-fields",
    severity: "blocking",
    message: "The listing description exceeds the maximum length.",
    limit: {
      name: "fieldLimits.descriptionMaxLength",
      value: OPENAI_FIELD_LIMITS.descriptionMaxLength,
    },
    source: errorsPage("§Listing fields → Description"),
  },
  {
    id: "listing-promotional-metadata",
    category: "listing-fields",
    severity: "blocking",
    message:
      "Listing metadata contains promotional language, pricing claims, or ranking claims.",
    source: errorsPage("§Listing fields → Description"),
  },
  {
    id: "listing-privacy-policy-missing",
    category: "listing-fields",
    severity: "blocking",
    message: "The listing declares no privacy policy URL.",
    source: errorsPage("§Listing fields → Links"),
  },
  {
    id: "listing-support-url-missing",
    category: "listing-fields",
    severity: "blocking",
    message: "The listing declares no support URL.",
    source: errorsPage("§Listing fields → Links"),
  },

  // ------------------------------------------------------------- mcp server
  {
    id: "mcp-endpoint-not-https",
    category: "mcp-server",
    severity: "blocking",
    message: "The MCP endpoint is not served over HTTPS.",
    source: errorsPage("§MCP tools → Endpoint"),
  },
  {
    id: "mcp-endpoint-unreachable",
    category: "mcp-server",
    severity: "blocking",
    message: "The MCP endpoint could not be reached during the scan.",
    source: errorsPage("§MCP tools → Endpoint"),
  },
  {
    id: "mcp-tool-name-too-long",
    category: "mcp-server",
    severity: "blocking",
    message: "A tool name exceeds the maximum length.",
    limit: {
      name: "fieldLimits.toolNameMaxLength",
      value: OPENAI_FIELD_LIMITS.toolNameMaxLength,
    },
    source: errorsPage("§MCP tools → Metadata"),
  },
  {
    id: "mcp-tool-description-missing",
    category: "mcp-server",
    severity: "blocking",
    message: "A tool declares no description.",
    source: errorsPage("§MCP tools → Metadata"),
  },
  {
    id: "mcp-tool-annotations-missing",
    category: "mcp-server",
    severity: "blocking",
    message: "A tool is missing one or more of the required annotation hints.",
    source: errorsPage("§MCP tools → Annotations"),
  },
  {
    id: "mcp-tool-schema-invalid",
    category: "mcp-server",
    severity: "blocking",
    message:
      "A tool's input or output schema is not a valid JSON Schema object.",
    source: errorsPage("§MCP tools → Schemas"),
  },
  {
    id: "mcp-domain-not-verified",
    category: "mcp-server",
    severity: "blocking",
    message: "The MCP server's domain has not completed domain verification.",
    source: errorsPage("§MCP tools → Domain verification"),
  },
  {
    id: "mcp-csp-domain-missing",
    category: "mcp-server",
    severity: "blocking",
    message:
      "A UI resource loads from a domain absent from the declared content security policy.",
    source: errorsPage("§MCP tools → Content security policy"),
  },
  {
    id: "mcp-ui-domain-missing",
    category: "mcp-server",
    severity: "blocking",
    message: "A UI resource declares no `_meta.ui.domain`.",
    source: errorsPage("§MCP tools → UI resources"),
  },
  {
    id: "mcp-ui-domain-duplicate",
    category: "mcp-server",
    severity: "blocking",
    message: "Two UI resources declare the same `_meta.ui.domain`.",
    source: errorsPage("§MCP tools → UI resources"),
  },
  {
    id: "mcp-ui-mime-invalid",
    category: "mcp-server",
    severity: "blocking",
    message: "A UI resource does not declare the plugin UI MIME profile.",
    source: errorsPage("§MCP tools → UI resources"),
  },

  // ------------------------------------------------------------- mcp skills
  {
    id: "mcp-skill-too-many",
    category: "mcp-skills",
    severity: "blocking",
    message: "The server advertises more importable skills than the maximum.",
    limit: {
      name: "mcpSkillLimits.maxSkills",
      value: OPENAI_MCP_SKILL_LIMITS.maxSkills,
    },
    source: errorsPage("§Skills → Imported from MCP"),
  },
  {
    id: "mcp-skill-markdown-too-large",
    category: "mcp-skills",
    severity: "blocking",
    message: "An imported skill's markdown exceeds the maximum size.",
    limit: {
      name: "mcpSkillLimits.maxSkillMarkdownBytes",
      value: OPENAI_MCP_SKILL_LIMITS.maxSkillMarkdownBytes,
    },
    source: errorsPage("§Skills → Imported from MCP"),
  },
  {
    id: "mcp-skill-page-too-large",
    category: "mcp-skills",
    severity: "blocking",
    message: "An imported skill's supporting page exceeds the maximum size.",
    limit: {
      name: "mcpSkillLimits.maxPageBytes",
      value: OPENAI_MCP_SKILL_LIMITS.maxPageBytes,
    },
    source: errorsPage("§Skills → Imported from MCP"),
  },
  {
    id: "mcp-skill-too-many-pages",
    category: "mcp-skills",
    severity: "blocking",
    message: "An imported skill has more supporting pages than the maximum.",
    limit: {
      name: "mcpSkillLimits.maxPagesPerSkill",
      value: OPENAI_MCP_SKILL_LIMITS.maxPagesPerSkill,
    },
    source: errorsPage("§Skills → Imported from MCP"),
  },
  {
    id: "mcp-skill-total-too-large",
    category: "mcp-skills",
    severity: "blocking",
    message: "An imported skill's total footprint exceeds the maximum.",
    limit: {
      name: "mcpSkillLimits.maxSkillTotalBytes",
      value: OPENAI_MCP_SKILL_LIMITS.maxSkillTotalBytes,
    },
    source: errorsPage("§Skills → Imported from MCP"),
  },
  {
    id: "mcp-skills-total-too-large",
    category: "mcp-skills",
    severity: "blocking",
    message: "The imported skills exceed the maximum combined size.",
    limit: {
      name: "mcpSkillLimits.maxImportedTotalBytes",
      value: OPENAI_MCP_SKILL_LIMITS.maxImportedTotalBytes,
    },
    source: errorsPage("§Skills → Imported from MCP"),
  },
  {
    id: "mcp-skill-digest-mismatch",
    category: "mcp-skills",
    severity: "blocking",
    message:
      "An imported skill's declared digest does not match the resource served for it.",
    source: errorsPage("§Skills → Imported from MCP"),
  },
  {
    id: "mcp-skill-frontmatter-mismatch",
    category: "mcp-skills",
    severity: "blocking",
    message:
      "An imported skill's listing metadata disagrees with its SKILL.md frontmatter.",
    source: errorsPage("§Skills → Imported from MCP"),
  },
  {
    id: "mcp-skill-scan-failed",
    category: "mcp-skills",
    severity: "blocking",
    message:
      "The skill scan failed, so the draft's imported skills were not updated.",
    source: errorsPage("§Skills → Imported from MCP"),
  },

  // ------------------------------------------------------- review materials
  {
    id: "review-success-tests-missing",
    category: "review-materials",
    severity: "blocking",
    message: "Fewer successful test cases were supplied than required.",
    limit: {
      name: "submissionTestCases.successCount",
      value: OPENAI_SUBMISSION_TEST_CASES.successCount,
    },
    source: errorsPage("§Review materials → Test cases"),
  },
  {
    id: "review-failure-tests-missing",
    category: "review-materials",
    severity: "blocking",
    message: "Fewer graceful-failure test cases were supplied than required.",
    limit: {
      name: "submissionTestCases.failureCount",
      value: OPENAI_SUBMISSION_TEST_CASES.failureCount,
    },
    source: errorsPage("§Review materials → Test cases"),
  },
  {
    id: "review-demo-credentials-missing",
    category: "review-materials",
    severity: "blocking",
    message:
      "The submission authenticates users but supplies no reviewer demo credentials.",
    source: errorsPage("§Review materials → Demo access"),
  },
  {
    id: "review-demo-recording-missing",
    category: "review-materials",
    severity: "blocking",
    message: "No demo recording was supplied.",
    source: errorsPage("§Review materials → Demo access"),
  },
  {
    id: "review-release-notes-missing",
    category: "review-materials",
    severity: "blocking",
    message: "An updated submission supplies no release notes.",
    source: errorsPage("§Review materials → Release notes"),
  },
  {
    id: "review-attestation-missing",
    category: "review-materials",
    severity: "blocking",
    message: "A required policy attestation was not affirmed.",
    source: errorsPage("§Review materials → Attestations"),
  },
  {
    id: "review-identity-not-verified",
    category: "review-materials",
    severity: "blocking",
    message: "The submitting account has not completed identity verification.",
    source: errorsPage("§Review materials → Account"),
  },
  {
    id: "review-write-permission-missing",
    category: "review-materials",
    severity: "blocking",
    message: "The submitting account lacks the app-write permission.",
    source: errorsPage("§Review materials → Account"),
  },
  {
    id: "review-geography-missing",
    category: "review-materials",
    severity: "blocking",
    message: "The submission declares no country availability.",
    source: errorsPage("§Review materials → Availability"),
  },
  {
    id: "review-annotation-justification-missing",
    category: "review-materials",
    severity: "advisory",
    message:
      "A tool annotated as destructive or open-world carries no justification for review.",
    source: errorsPage("§Review materials → Test cases"),
  },
  {
    id: "review-scan-stale",
    category: "review-materials",
    severity: "blocking",
    message:
      "The draft's scan predates the current server contract; re-run Scan Tools.",
    source: errorsPage("§MCP tools → Scan"),
  },

  // ------------------------------------------------------------- exclusions
  {
    id: "exclusion-mcp-servers-in-skills-only",
    category: "exclusions",
    severity: "blocking",
    message:
      "A skills-only submission declares MCP servers, which that shape excludes.",
    source: errorsPage("§Shared package checks → Excluded content"),
  },
  {
    id: "exclusion-app-config-in-public-package",
    category: "exclusions",
    severity: "blocking",
    message:
      "The package contains an `.app.json`, which maps registered connections for local or workspace use and is excluded from a public submission.",
    source: errorsPage("§Shared package checks → Excluded content"),
  },
  {
    id: "exclusion-screenshots-without-ui",
    category: "exclusions",
    severity: "blocking",
    message:
      "Screenshots were supplied for a submission that renders no UI template.",
    source: errorsPage("§Images → Screenshots"),
  },
  {
    id: "exclusion-bundle-in-mcp-only",
    category: "exclusions",
    severity: "blocking",
    message: "An MCP-only submission supplies a package archive.",
    source: errorsPage("§Shared package checks → Excluded content"),
  },
  {
    id: "exclusion-unsupported-surface",
    category: "exclusions",
    severity: "blocking",
    message:
      "The package contains a surface the plugin directory does not support.",
    source: errorsPage("§Shared package checks → Excluded content"),
  },
] as const;

/** The catalog keyed by id, for a check that already knows which code it means. */
export const OPENAI_PORTAL_ERRORS_BY_ID: Readonly<
  Record<string, OpenAIPortalErrorDefinition>
> = Object.freeze(
  Object.fromEntries(
    OPENAI_PORTAL_ERRORS.map((definition) => [definition.id, definition]),
  ),
);

export type OpenAIPortalErrorId = string;

/**
 * One occurrence of a catalog entry against a specific target.
 *
 * The reader's unit of evidence: which code, where it tripped, and what was
 * observed. Findings carry arrays of these in `details.portalIssues` so a
 * grouped finding never loses a single documented code.
 */
export interface OpenAIPortalIssue {
  id: OpenAIPortalErrorId;
  category: OpenAIPortalErrorCategory;
  severity: OpenAIPortalErrorSeverity;
  message: string;
  /** Package path, tool name, field name — whatever the code is about. */
  subject?: string;
  /** What was actually seen, next to what was required. */
  observed?: string | number;
  expected?: string | number;
}

/**
 * Build an issue from a catalog id.
 *
 * Throws on an unknown id rather than fabricating an entry: a check that raises
 * a code the catalog does not define is a bug in the check, and the loudest
 * possible failure is the cheapest one to fix. It also keeps the invariant that
 * every `portalIssues` entry corresponds to a documented code.
 */
export function openaiPortalIssue(
  id: OpenAIPortalErrorId,
  details: Pick<OpenAIPortalIssue, "subject" | "observed" | "expected"> = {},
): OpenAIPortalIssue {
  const definition = OPENAI_PORTAL_ERRORS_BY_ID[id];
  if (!definition) {
    throw new Error(`Unknown OpenAI portal error id: ${id}`);
  }
  return {
    id: definition.id,
    category: definition.category,
    severity: definition.severity,
    message: definition.message,
    ...details,
  };
}

/** Whether any of these issues is one the portal treats as blocking. */
export function hasBlockingPortalIssue(
  issues: readonly OpenAIPortalIssue[],
): boolean {
  return issues.some((issue) => issue.severity === "blocking");
}

/** Group issues by category, for a finding that reports one family at a time. */
export function groupPortalIssues(
  issues: readonly OpenAIPortalIssue[],
): Map<OpenAIPortalErrorCategory, OpenAIPortalIssue[]> {
  const grouped = new Map<OpenAIPortalErrorCategory, OpenAIPortalIssue[]>();
  for (const issue of issues) {
    const bucket = grouped.get(issue.category);
    if (bucket) bucket.push(issue);
    else grouped.set(issue.category, [issue]);
  }
  return grouped;
}
