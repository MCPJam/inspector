/**
 * The page's "Final directory submission" tables: what "Submit for review"
 * checks beyond the upload, with stricter listing limits.
 *
 * Pure data. Safe from the browser entry.
 */

import {
  CAPABILITY,
  DESCRIPTION,
  DEVELOPER,
  DISPLAY_NAME,
  NON_EMPTY,
  ONE_LINE,
  PROMPT,
  PROMPTS,
  REQUIRED,
  SUBTITLE,
  TEXT,
  excludes,
  field,
  maxLength,
  portalTable,
} from "./define.js";

/** An `@name` that mentions an MCP server; an email address is not one. */
const NO_SERVER_MENTION = excludes(/(?:^|\s)@\S/);

/**
 * Final metadata errors. The page: "In these error names, `subtitle` means
 * short description and `description` means long description."
 */
export const FINAL_METADATA_ERRORS = portalTable({
  table: "Final metadata errors",
  stage: "submission",
  document: "plugin-manifest",
  rows: [
    "submission_display_name_required: Display name is required, non-empty, and single-line.",
    "submission_display_name_too_long: Display name must be 30 characters or fewer.",
    "submission_display_name_character_unsupported: Display name must use supported text and fit on one line.",
    "submission_subtitle_required: Short description is required, non-empty, and single-line.",
    "submission_subtitle_too_long: Short description must be 30 characters or fewer.",
    "submission_subtitle_character_unsupported: Short description must use supported text and fit on one line.",
    "submission_description_required: Long description is required and must be non-empty. Line breaks are allowed.",
    "submission_description_too_long: Long description must be 4,000 characters or fewer.",
    "submission_description_character_unsupported: Long description must use supported text. Line breaks are allowed.",
    "submission_developer_name_required: Developer name is required, non-empty, and single-line.",
    "submission_developer_name_too_long: Developer name must be 80 characters or fewer.",
    "submission_developer_name_character_unsupported: Developer name must use supported text and fit on one line.",
    "plugin_capability_invalid: Each capability must be non-empty, use supported text, fit on one line, and be 120 characters or fewer.",
    "plugin_default_prompt_mention: Starter prompts must not contain MCP server `@mentions`.",
    "plugin_default_prompt_duplicate: Starter prompts must be unique after Unicode and whitespace normalization.",
  ],
  targets: {
    submission_display_name_required: field(DISPLAY_NAME, REQUIRED),
    submission_display_name_too_long: field(DISPLAY_NAME, maxLength(30)),
    submission_display_name_character_unsupported: field(
      DISPLAY_NAME,
      ONE_LINE
    ),
    submission_subtitle_required: field(SUBTITLE, REQUIRED),
    submission_subtitle_too_long: field(SUBTITLE, maxLength(30)),
    submission_subtitle_character_unsupported: field(SUBTITLE, ONE_LINE),
    submission_description_required: field(DESCRIPTION, REQUIRED),
    submission_description_too_long: field(DESCRIPTION, maxLength(4000)),
    submission_description_character_unsupported: field(DESCRIPTION, TEXT),
    submission_developer_name_required: field(DEVELOPER, REQUIRED),
    submission_developer_name_too_long: field(DEVELOPER, maxLength(80)),
    submission_developer_name_character_unsupported: field(DEVELOPER, ONE_LINE),
    plugin_capability_invalid: field(
      CAPABILITY,
      NON_EMPTY,
      ONE_LINE,
      maxLength(120)
    ),
    plugin_default_prompt_mention: field(PROMPT, NO_SERVER_MENTION),
    plugin_default_prompt_duplicate: field(PROMPTS),
  },
});

/** MCP and review errors: "These errors apply to remote MCP submissions." */
export const MCP_REVIEW_ERRORS = portalTable({
  table: "MCP and review errors",
  stage: "submission",
  rows: [
    "annotations_required: Every MCP tool must set `readOnlyHint`, `openWorldHint`, and `destructiveHint` accurately.",
    "justification_required: Every MCP tool annotation must include a justification for its read-only, open-world, or destructive behavior.",
    "scan_required: MCP tools must have a successful, current scan of the production MCP server.",
    "domain_verification_required: The exact verification token must be hosted at the generated `/.well-known/openai-apps-challenge` URL on the MCP host or an allowed parent host, and **Verify Domain** must pass.",
    "frame_domain_explanation_required: Every external frame domain reported by the MCP tool scan must have an explanation of why the UI needs it and what content it provides.",
  ],
});
