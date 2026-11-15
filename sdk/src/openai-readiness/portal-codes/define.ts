/**
 * How the portal's code tables are written down: what a table holds, what a
 * code is about, and the rules the generic validators run for it.
 *
 * Pure data. Safe from the browser entry.
 */

import { PLUGIN_PORTAL_RULES_SOURCE } from "../../plugin-bundle/portal-rules.js";

/** The tables of the submission-errors page, in the page's order. */
export const OPENAI_PORTAL_CODE_TABLES = [
  "Final metadata errors",
  "MCP and review errors",
  "ZIP upload errors and warnings",
  "ZIP structure and limit errors",
  "Plugin root errors",
  "Plugin manifest errors",
  "Listing and interface errors",
  "Plugin content errors",
  "MCP manifest errors",
  "Skill errors",
  "Skill agent metadata errors",
  "Asset path errors",
  "Image errors",
  "MCP server reference errors",
  "Package warnings",
] as const;

export type OpenAIPortalCodeTable = (typeof OPENAI_PORTAL_CODE_TABLES)[number];

/**
 * When the portal reports a code: on upload of the ZIP, or on "Submit for
 * review", whose checks the page lists under "Final directory submission".
 */
export type OpenAIPortalCodeStage = "upload" | "submission";

/** The page: "Errors block submission. Warnings don't block submission". */
export type OpenAIPortalCodeSeverity = "error" | "warning";

/** A document whose fields a table's codes name. */
export type OpenAIPortalDocument =
  /** The plugin manifest as the portal normalizes it (`.codex-plugin/plugin.json`). */
  | "plugin-manifest"
  /** A skill's `SKILL.md` front matter. */
  | "skill-frontmatter"
  /** A skill's `agents/openai.yaml`. */
  | "skill-agent"
  | "mcp-config"
  | "app-config";

export type OpenAIPortalValueType = "string" | "boolean" | "object" | "array";

/** One check a generic validator runs against a field. */
export type OpenAIPortalRule =
  /** The field is there. `null` is there, and fails a type rule instead. */
  | { kind: "present" }
  | { kind: "type"; types: readonly OpenAIPortalValueType[] }
  /** Not only whitespace. `required` also fails a missing field. */
  | { kind: "nonEmpty"; required?: true }
  /** In characters. `submissionMax` is the stricter final-submission limit. */
  | { kind: "length"; max: number; submissionMax?: number }
  /** The value must match, or with `forbidden` must not match. */
  | { kind: "pattern"; pattern: RegExp; forbidden?: true }
  | { kind: "enum"; values: readonly string[] }
  /** Entries in a list. */
  | { kind: "count"; max: number }
  /** The page's supported text; `singleLine` also refuses line breaks. */
  | { kind: "text"; singleLine?: true };

/** What a code is about, when the page names it. */
export interface PortalCodeTarget {
  /**
   * A field of the table's document, dotted. `*` is each value of an object
   * and `[]` each entry of a list.
   */
  field?: string;
  /** A file or folder in the package. */
  path?: string;
  /** What the generic validators check `field` against, in order. */
  rules?: readonly OpenAIPortalRule[];
}

/** The page the codes were copied from, and when: the parser's capture. */
export const OPENAI_PORTAL_CODES_SOURCE = PLUGIN_PORTAL_RULES_SOURCE;

export interface PortalCodeRow<Code extends string> extends PortalCodeTarget {
  code: Code;
  table: OpenAIPortalCodeTable;
  stage: OpenAIPortalCodeStage;
  severity: OpenAIPortalCodeSeverity;
  /** The page's words, with its Markdown and without its links. */
  message: string;
  /** The document `field` belongs to. */
  document?: OpenAIPortalDocument;
  source: typeof OPENAI_PORTAL_CODES_SOURCE;
}

type CodeOf<Row extends string> = Row extends `${infer Code}: ${string}`
  ? Code
  : never;

/** A table: the page's code and message per row, the rest per table. */
interface PortalTableSpec<Row extends string> {
  table: OpenAIPortalCodeTable;
  stage: OpenAIPortalCodeStage;
  /** The document the table's `field`s belong to. */
  document?: OpenAIPortalDocument;
  /** Set when the whole table is warnings. */
  severity?: "warning";
  /** Codes a table of errors and warnings marks as warnings by its wording. */
  warnings?: readonly CodeOf<Row>[];
  /** `code: message`, verbatim and in the page's order. */
  rows: readonly Row[];
  targets?: Partial<Record<CodeOf<Row>, PortalCodeTarget>>;
}

/** A table's codes, in the page's order, each typed as its literal code. */
export function portalTable<const Row extends string>(
  spec: PortalTableSpec<Row>
): PortalCodeRow<CodeOf<Row>>[] {
  return spec.rows.map((row) => {
    const split = row.indexOf(": ");
    // The type above reads the same prefix; a string cannot carry it here.
    const code = row.slice(0, split) as CodeOf<Row>;
    const target = spec.targets?.[code];
    return {
      code,
      table: spec.table,
      stage: spec.stage,
      severity:
        spec.severity ?? (spec.warnings?.includes(code) ? "warning" : "error"),
      message: row.slice(split + 2),
      ...(target?.field === undefined ? {} : { document: spec.document }),
      ...target,
      source: OPENAI_PORTAL_CODES_SOURCE,
    };
  });
}

type Rule = OpenAIPortalRule;

export const PRESENT: Rule = { kind: "present" };
export const NON_EMPTY: Rule = { kind: "nonEmpty" };
/** The page's "is required and must be non-empty". */
export const REQUIRED: Rule = { kind: "nonEmpty", required: true };
export const TEXT: Rule = { kind: "text" };
/** Supported text that fits on one line. */
export const ONE_LINE: Rule = { kind: "text", singleLine: true };
export const ofType = (...types: OpenAIPortalValueType[]): Rule => ({
  kind: "type",
  types,
});
export const STRING = ofType("string");
export const OBJECT = ofType("object");
export const BOOLEAN = ofType("boolean");
export const maxLength = (max: number, submissionMax?: number): Rule =>
  submissionMax === undefined
    ? { kind: "length", max }
    : { kind: "length", max, submissionMax };
export const matches = (pattern: RegExp): Rule => ({
  kind: "pattern",
  pattern,
});
export const excludes = (pattern: RegExp): Rule => ({
  kind: "pattern",
  pattern,
  forbidden: true,
});
export const oneOf = (values: readonly string[]): Rule => ({
  kind: "enum",
  values,
});
export const maxCount = (max: number): Rule => ({ kind: "count", max });

/** A code about `name` in its table's document, checked by `rules`. */
export const field = (name: string, ...rules: Rule[]): PortalCodeTarget =>
  rules.length > 0 ? { field: name, rules } : { field: name };

/** A code about a file or folder in the package. */
export const file = (path: string): PortalCodeTarget => ({ path });

// Listing fields the final checks name too. The page calls the short
// description the subtitle and the long one the description.
export const DISPLAY_NAME = "interface.displayName";
export const SUBTITLE = "interface.shortDescription";
export const DESCRIPTION = "interface.longDescription";
export const DEVELOPER = "interface.developerName";
export const CAPABILITY = "interface.capabilities[]";
export const PROMPTS = "interface.defaultPrompt";
/** A string counts as a list of one prompt. */
export const PROMPT = "interface.defaultPrompt[]";

/**
 * A version such as `1.0.0`, with optional pre-release and build parts: the
 * semver.org 2.0.0 grammar, so no leading zeros and no empty identifiers.
 */
const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE_ID = `(?:${SEMVER_NUMBER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
export const SEMVER = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}` +
    `(?:-${SEMVER_PRERELEASE_ID}(?:\\.${SEMVER_PRERELEASE_ID})*)?` +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
);

/** `#RRGGBB`. */
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/**
 * The page: "HTTPS URLs must include a host and contain no embedded
 * credentials". An authority that starts with `:` is a port with no host.
 */
export const HTTPS_URL = /^https:\/\/(?!:)[^\s/?#@]+(?:[/?#]\S*)?$/i;
