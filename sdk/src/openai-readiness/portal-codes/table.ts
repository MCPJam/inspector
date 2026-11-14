/**
 * The ChatGPT portal's submission error codes: all 269 on its
 * submission-errors page, as data.
 *
 * Each code keeps the page's message word for word (links dropped), the table
 * that lists it, whether it blocks, and when the portal reports it. Where the
 * page names the field or file a code is about, so does the code, and where its
 * rule is a field's presence, type, length, pattern, values or count, the
 * validators in `validate.ts` check it.
 *
 * Pure data. Safe from the browser entry.
 */

import {
  PLUGIN_ROOT_ERRORS,
  ZIP_STRUCTURE_ERRORS,
  ZIP_UPLOAD_ERRORS,
} from "./archive.js";
import {
  ASSET_PATH_ERRORS,
  IMAGE_ERRORS,
  PACKAGE_WARNINGS,
  SKILL_AGENT_ERRORS,
  SKILL_ERRORS,
} from "./content.js";
import type { PortalCodeRow } from "./define.js";
import { LISTING_ERRORS } from "./listing.js";
import {
  MCP_MANIFEST_ERRORS,
  MCP_SERVER_REFERENCE_ERRORS,
  PLUGIN_CONTENT_ERRORS,
  PLUGIN_MANIFEST_ERRORS,
} from "./manifest.js";
import { FINAL_METADATA_ERRORS, MCP_REVIEW_ERRORS } from "./submission.js";

// The page's order, table by table.
const ROWS = [
  ...FINAL_METADATA_ERRORS,
  ...MCP_REVIEW_ERRORS,
  ...ZIP_UPLOAD_ERRORS,
  ...ZIP_STRUCTURE_ERRORS,
  ...PLUGIN_ROOT_ERRORS,
  ...PLUGIN_MANIFEST_ERRORS,
  ...LISTING_ERRORS,
  ...PLUGIN_CONTENT_ERRORS,
  ...MCP_MANIFEST_ERRORS,
  ...SKILL_ERRORS,
  ...SKILL_AGENT_ERRORS,
  ...ASSET_PATH_ERRORS,
  ...IMAGE_ERRORS,
  ...MCP_SERVER_REFERENCE_ERRORS,
  ...PACKAGE_WARNINGS,
];

export type OpenAIPortalCode = (typeof ROWS)[number]["code"];

export type OpenAIPortalCodeDefinition = PortalCodeRow<OpenAIPortalCode>;

export const OPENAI_PORTAL_CODES: readonly OpenAIPortalCodeDefinition[] = ROWS;

export const OPENAI_PORTAL_CODES_BY_CODE: Readonly<
  Record<string, OpenAIPortalCodeDefinition>
> = Object.freeze(
  Object.fromEntries(ROWS.map((definition) => [definition.code, definition]))
);

export function isOpenAIPortalCode(value: string): value is OpenAIPortalCode {
  return Object.hasOwn(OPENAI_PORTAL_CODES_BY_CODE, value);
}
