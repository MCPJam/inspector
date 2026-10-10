/**
 * The slop patterns the ratchet counts. `measure.mjs` reports them across the
 * repo, `ratchet.mjs` fails a PR whose changed files add more than they
 * remove, and `check-file.mjs` reports them on one file as an agent edits it.
 * All three read this list, so a rule added here is enforced everywhere.
 *
 * These are text counts, not a parser. A rule earns its place by being cheap,
 * stable and hard to hit by accident; anything that needs types belongs in
 * ESLint instead.
 */

import { extractUiStrings, isUiFile } from "./ui-strings.mjs";

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const EXCLUDED_PATH =
  /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|__tests__|__mocks__|__fixtures__|fixtures|e2e|tests?)\//;

// `scripts/slop/` is excluded because it spells out the patterns it counts.
const EXCLUDED_FILE =
  /\.(?:test|spec|stories|bundled|generated)\.[^/]+$|\.d\.ts$|(?:^|\/)vendor\/|^scripts\/slop\//;

/** Hand-written, non-test source. Tests are measured separately, not here. */
export function isMeasuredFile(path) {
  return (
    SOURCE_EXTENSIONS.test(path) &&
    !EXCLUDED_PATH.test(path) &&
    !EXCLUDED_FILE.test(path)
  );
}

const SERVER_PATH = /^mcpjam-inspector\/server\//;

/** A comment line: `//`, or a line inside a block comment that starts with `*`. */
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;

/**
 * MCP protocol and MCP Apps versions are dates, and comments cite them to
 * explain era-specific behavior. They are not history, so the history rule
 * removes them first. Add a version here when the SDK starts using it.
 */
export const PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-01-26",
  "2026-07-28",
];

const PROTOCOL_VERSION = new RegExp(PROTOCOL_VERSIONS.join("|"), "g");

function stripProtocolVersions(text) {
  return text.replace(PROTOCOL_VERSION, "");
}

const HISTORY =
  /(?:(?:^|[^\w&])#\d{3,5}\b|\bPR\s*#?\d{3,5}\b|\b20\d\d-\d\d-\d\d\b)/;

function countMatches(text, regex) {
  return text.match(regex)?.length ?? 0;
}

function countCommentLines(text, regex) {
  let count = 0;
  for (const line of text.split("\n")) {
    if (COMMENT_LINE.test(line) && regex.test(line)) count += 1;
  }
  return count;
}

/** Strings of user-facing copy in a UI file that match `regex`. */
function countCopy(text, regex) {
  return extractUiStrings(text).filter((item) => regex.test(item.text)).length;
}

/** Words that sell instead of saying what happens. `harness` is a domain term here. */
const FILLER =
  /\b(?:leverage|seamless(?:ly)?|robust|effortless(?:ly)?|empower|streamline|delve|supercharge|elevate|cutting-edge|game[- ]chang(?:er|ing)|revolutioni[sz]e|utili[sz]e)\b/i;

/** An error that names neither what failed nor what to do next. */
const VAGUE_ERROR =
  /^(?:oops|whoops|uh[- ]oh|something went wrong|an? (?:unexpected |unknown )?error (?:has )?occurred|unknown error|error occurred)\b/i;

export const RULES = [
  {
    id: "as-any",
    label: "`as any` casts",
    count: (text) => countMatches(text, /\bas\s+any\b/g),
  },
  {
    id: "any-annotation",
    label: "`: any` annotations",
    count: (text) => countMatches(text, /[\w)\]?]\s*:\s*any\b(?![-\w])/g),
  },
  {
    id: "as-unknown-as",
    label: "`as unknown as` double casts",
    count: (text) => countMatches(text, /\bas\s+unknown\s+as\b/g),
  },
  {
    id: "ts-suppression",
    label: "`@ts-ignore` / `@ts-nocheck` / `@ts-expect-error`",
    count: (text) =>
      countMatches(text, /@ts-(?:ignore|nocheck|expect-error)\b/g),
  },
  {
    id: "swallowed-catch-callback",
    label: "`.catch(() => {})` with no body",
    count: (text) =>
      countMatches(
        text,
        /\.catch\(\s*(?:async\s+)?(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)/g
      ),
  },
  {
    id: "empty-catch-block",
    label: "empty `catch {}` with no reason comment",
    count: (text) =>
      countMatches(text, /\bcatch\s*(?:\(\s*[\w{}\s,:]*\))?\s*\{\s*\}/g),
  },
  {
    id: "eslint-disable",
    label: "`eslint-disable` directives",
    count: (text) => countMatches(text, /eslint-disable/g),
  },
  {
    id: "server-console",
    label: "raw `console.*` in the inspector server",
    appliesTo: (path) => SERVER_PATH.test(path),
    count: (text) =>
      countMatches(text, /\bconsole\.(?:log|info|warn|error|debug)\(/g),
  },
  {
    id: "history-comment",
    label: "comments citing a PR number or a date",
    count: (text) => countCommentLines(stripProtocolVersions(text), HISTORY),
  },
  // Copy rules read only the strings a user sees (ui-strings.mjs), so a dash
  // or a sales word in a comment or an identifier does not count.
  {
    id: "ui-dash",
    label: "em or en dashes in user-facing copy",
    appliesTo: isUiFile,
    count: (text) => countCopy(text, /\w\s*[\u2013\u2014]\s*\w/),
  },
  {
    id: "ui-filler",
    label: "marketing filler in user-facing copy",
    appliesTo: isUiFile,
    count: (text) => countCopy(text, FILLER),
  },
  {
    id: "ui-vague-error",
    label: "errors that name no cause and no next step",
    appliesTo: isUiFile,
    count: (text) => countCopy(text, VAGUE_ERROR),
  },
];

/** Count every rule that applies to `path`. Rules that do not apply are 0. */
export function countFile(path, text) {
  const counts = {};
  for (const rule of RULES) {
    counts[rule.id] =
      rule.appliesTo && !rule.appliesTo(path) ? 0 : rule.count(text);
  }
  return counts;
}
