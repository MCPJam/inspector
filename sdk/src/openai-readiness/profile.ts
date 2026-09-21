/**
 * OpenAI's own constants — the values a submission has to match, as opposed to
 * the requirements it has to satisfy.
 *
 * Kept apart from the checks so that a host-side change (a new well-known path,
 * a different archive ceiling) is one edit to a named constant rather than a
 * grep through check bodies for a number.
 *
 * EVERY NUMERIC LIMIT IN THIS PRODUCT LIVES HERE, EXACTLY ONCE. The portal
 * error catalog in `portal-errors.ts` REFERENCES these rather than restating
 * them, and a unit test asserts that correspondence: two copies of "5000
 * entries" is two places to update when it becomes 6000, and the copy that
 * gets missed is the one a submitter is graded against.
 *
 * Pure data. Safe from the browser entry.
 */

import { openaiPolicySource } from "./manifest.js";

/**
 * The archive the submission portal validates.
 *
 * Two size ceilings, not one, and they measure different things: a ZIP is
 * rejected on the bytes UPLOADED and again on the bytes it expands to, because
 * a small archive that expands to gigabytes is the classic decompression bomb.
 * A check that only knew the compressed limit would pass one.
 */
export const OPENAI_ARCHIVE_LIMITS = {
  /** Bytes of the uploaded `.zip` itself. */
  maxCompressedBytes: 100 * 1024 * 1024,
  /** Bytes of everything inside it, summed. */
  maxUncompressedBytes: 512 * 1024 * 1024,
  /** Entries in the archive, directories included. */
  maxEntries: 5_000,
} as const;

/**
 * Where the plugin manifest may live inside the package.
 *
 * `.codex-plugin/` is canonical. The other two are accepted and NORMALISED —
 * recorded as an assumption on the evidence rather than silently rewritten,
 * because a submitter whose package works only after a normalisation we applied
 * has not been told the truth about their package.
 */
export const OPENAI_MANIFEST_LOCATIONS = {
  canonical: ".codex-plugin/plugin.json",
  accepted: [".agent-plugin/plugin.json", ".claude-plugin/plugin.json"],
} as const;

/** Where a skill's own metadata lives, relative to its skill directory. */
export const OPENAI_SKILL_METADATA_PATH = "SKILL.md";

/** The plugin-scoped OpenAI interface/policy document, per skill and per plugin. */
export const OPENAI_AGENT_METADATA_PATH = "agents/openai.yaml";

/**
 * Listing and interface field bounds.
 *
 * Deterministic to check, which is exactly why they belong to the
 * directory-policy lane and not to a heuristic one.
 */
export const OPENAI_FIELD_LIMITS = {
  nameMaxLength: 100,
  displayNameMaxLength: 100,
  shortDescriptionMaxLength: 255,
  descriptionMaxLength: 2_000,
  defaultPromptMaxLength: 255,
  /** MCP tool names the host will accept. */
  toolNameMaxLength: 64,
  /** Skill names, which double as directory names inside the package. */
  skillNameMaxLength: 64,
} as const;

/**
 * The directory's category enum.
 *
 * A closed list rather than free text: a submission naming a category outside
 * it is rejected, so a check that accepted any string would pass a submission
 * the portal will not.
 */
export const OPENAI_LISTING_CATEGORIES = [
  "productivity",
  "education",
  "developer-tools",
  "design",
  "writing",
  "research",
  "data-analysis",
  "marketing",
  "sales",
  "finance",
  "health",
  "travel",
  "entertainment",
] as const;

export type OpenAIListingCategory = (typeof OPENAI_LISTING_CATEGORIES)[number];

/**
 * Listing image constraints.
 *
 * Square is a hard requirement, not a recommendation — the directory crops
 * nothing — which is why the check compares width to height rather than to a
 * ratio tolerance.
 */
export const OPENAI_IMAGE_CONSTRAINTS = {
  minEdgePx: 48,
  maxEdgePx: 4_096,
  mustBeSquare: true,
  maxBytes: 5 * 1024 * 1024,
  /** Raster formats the portal accepts, plus SVG under its own rules. */
  acceptedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
} as const;

/**
 * The backgrounds a brand colour is composited against.
 *
 * BOTH, not either: ChatGPT renders light and dark, and a colour that is
 * legible on one and invisible on the other fails for half the users. The
 * threshold is a CONTRAST RATIO, so the check needs the actual pair.
 */
export const OPENAI_BRAND_COLOR_CONTRAST = {
  lightBackground: "#FFFFFF",
  darkBackground: "#212121",
  /**
   * WCAG relative-luminance contrast ratio. 2:1 rather than the 4.5:1 of body
   * text because a brand colour is an accent, not something anyone reads.
   */
  minRatio: 2,
} as const;

/**
 * Caps on skills imported from an MCP server's `io.modelcontextprotocol/skills`
 * extension.
 *
 * Four different byte ceilings because they bound four different things, and
 * collapsing them would let a submission pass one gate while failing the one
 * that actually applies to it.
 */
export const OPENAI_MCP_SKILL_LIMITS = {
  /** One skill's `SKILL.md` body. */
  maxSkillMarkdownBytes: 256 * 1024,
  /** One supporting resource fetched via `resources/read`. */
  maxPageBytes: 1024 * 1024,
  /** One skill's total footprint, its pages included. */
  maxSkillTotalBytes: 5 * 1024 * 1024,
  /** Every imported skill on the server, summed. */
  maxImportedTotalBytes: 8 * 1024 * 1024,
  maxSkills: 5,
  maxPagesPerSkill: 10,
} as const;

/**
 * The MCP extension an importable skill set is advertised under, and the
 * methods that read it.
 */
export const OPENAI_MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
export const OPENAI_MCP_SKILLS_METHODS = {
  list: "skills/list",
  get: "skills/get",
} as const;

/**
 * Domain verification.
 *
 * Served over HTTPS at a fixed path on the plugin's own origin; the portal
 * compares the body to a token it issued. A preflight can verify the path
 * responds and the token matches WHAT THE SUBMITTER SAID it should be — it
 * cannot verify the portal issued that token, which is why the finding's
 * provenance stays honest about the declared half.
 */
export const OPENAI_DOMAIN_VERIFICATION_PATH =
  "/.well-known/openai-apps-challenge";

/**
 * The MIME profile a plugin UI resource must declare.
 *
 * `text/html` alone is not it: the profile parameter is what tells the host the
 * payload is an app rather than a document, and a mismatch is a rendering
 * failure rather than a style note.
 */
export const OPENAI_APP_HTML_MIME = "text/html;profile=mcp-app";

/** The MCP endpoint path the host expects a public submission to serve. */
export const OPENAI_EXPECTED_MCP_PATH = "/mcp";

/**
 * The tool annotation hints the directory requires on EVERY tool.
 *
 * All three, on every tool, with no default: an unannotated tool is not
 * "assumed safe", it is unreviewable, and the portal treats it that way.
 */
export const OPENAI_REQUIRED_TOOL_ANNOTATIONS = [
  "readOnlyHint",
  "destructiveHint",
  "openWorldHint",
] as const;

/**
 * Test cases the submission form collects.
 *
 * Five that must succeed and three that must fail gracefully. The failing three
 * are the point of the requirement — anyone can demo a happy path — so they are
 * counted separately rather than as one total of eight.
 */
export const OPENAI_SUBMISSION_TEST_CASES = {
  successCount: 5,
  failureCount: 3,
} as const;

/**
 * Version and snapshot semantics from the app-review lifecycle.
 *
 * These are not limits but RULES, and they are constants because
 * `release-contract` grades a diff against them: which changes force a rescan
 * and a fresh review, which force a new listing entirely, and which are allowed
 * to go live against an already-published version.
 */
export const OPENAI_RELEASE_RULES = {
  /**
   * Changing the MCP server's ORIGIN — scheme, host or port — is a new plugin,
   * not a new version. A path change is an ordinary version bump.
   */
  originChangeRequiresNewPlugin: true,
  /** UI content served from an unchanged URI may change without a review. */
  uiContentChangesStayLive: true,
  /** How long the host may serve a cached UI resource. */
  uiContentCacheSeconds: 3_600,
} as const;

/**
 * The whole profile as one object, with its provenance attached, so a surface
 * can render "graded against OpenAI's published plugin profile, snapshot
 * 2026-08-19" without reassembling it from loose constants.
 */
export const OPENAI_HOST_PROFILE = {
  archiveLimits: OPENAI_ARCHIVE_LIMITS,
  manifestLocations: OPENAI_MANIFEST_LOCATIONS,
  fieldLimits: OPENAI_FIELD_LIMITS,
  listingCategories: OPENAI_LISTING_CATEGORIES,
  imageConstraints: OPENAI_IMAGE_CONSTRAINTS,
  brandColorContrast: OPENAI_BRAND_COLOR_CONTRAST,
  mcpSkillLimits: OPENAI_MCP_SKILL_LIMITS,
  domainVerificationPath: OPENAI_DOMAIN_VERIFICATION_PATH,
  appHtmlMime: OPENAI_APP_HTML_MIME,
  expectedMcpPath: OPENAI_EXPECTED_MCP_PATH,
  requiredToolAnnotations: OPENAI_REQUIRED_TOOL_ANNOTATIONS,
  submissionTestCases: OPENAI_SUBMISSION_TEST_CASES,
  releaseRules: OPENAI_RELEASE_RULES,
  source: openaiPolicySource("deploy/submission", "Host profile constants"),
} as const;
