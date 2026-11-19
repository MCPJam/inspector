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
const CLIENT_PATH = /^mcpjam-inspector\/client\//;

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

/**
 * A comment that justifies a workaround instead of fixing its cause: a named
 * hack, a wait for React or the browser to catch up, a deferral by a frame or
 * tick, or a cause nobody understood. Chosen from the words that, in this
 * repo's comments, almost only appear in that sense; "deliberately",
 * "best-effort" and "defensive" mostly explain real decisions, so they are not
 * here.
 */
const WORKAROUND =
  /(?<!\bnot (?:an? )?)\b(?:hack(?:s|y|ish)?|workarounds?)\b|\b(?:wait|yield|defer|delay)(?:s|ed|ing)?\b[^.]{0,40}\b(?:React|the DOM|the browser)\b[^.]{0,30}\b(?:commit|flush|paint|render|settle|catch(?:es)? up)|\b(?:wait|yield|defer|delay)(?:s|ed|ing)?\b[^.]{0,30}\b(?:one|a|the next|another) (?:frame|tick|paint)\b|\b(?:for (?:some|whatever) reason|no idea why|not sure why)\b/i;

/**
 * A third-party bug tracker link. A workaround forced by someone else's bug
 * cannot be fixed here, and the link is how a reader knows when to remove it.
 * Our own issues do not count: those are ours to fix.
 */
const UPSTREAM_ISSUE =
  /https?:\/\/(?:github\.com\/(?!mcpjam\/)[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+|(?:crbug\.com|bugs\.[\w.-]+|bugzilla\.[\w.-]+)\/)/i;

/** Like `countCommentLines`, but a comment block that links `exempt` counts 0. */
function countUnexemptCommentLines(text, regex, exempt) {
  let count = 0;
  let block = 0;
  let exempted = false;
  for (const line of text.split("\n")) {
    if (!COMMENT_LINE.test(line)) {
      if (!exempted) count += block;
      block = 0;
      exempted = false;
      continue;
    }
    if (exempt.test(line)) exempted = true;
    if (regex.test(line)) block += 1;
  }
  return exempted ? count : count + block;
}

/** Strings of user-facing copy in a UI file that match `regex`. */
function countCopy(text, regex) {
  return extractUiStrings(text).filter((item) => regex.test(item.text)).length;
}

/** Words that sell instead of saying what happens. `harness` is a domain term here. */
const FILLER =
  /\b(?:leverage|seamless(?:ly)?|robust|effortless(?:ly)?|empower|streamline|delve|supercharge|elevate|cutting-edge|game[- ]chang(?:er|ing)|revolutioni[sz]e|utili[sz]e)\b/i;

/**
 * An error that opens by saying nothing about what failed. A next step after
 * it ("please try again") does not rescue it: the user still cannot tell what
 * happened, which is the case the copy standard asks every error to cover.
 */
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
    id: "comment-only-catch",
    label: "`catch` blocks that hold only a comment",
    fix: "Handle the error, or log it at debug level next to the reason. A comment alone hides the failure from whoever debugs it next.",
    count: (text) =>
      countMatches(
        text,
        /\bcatch\s*(?:\(\s*[\w{}\s,:]*\))?\s*\{\s*(?:(?:\/\/[^\n]*\n|\/\*(?:[^*]|\*(?!\/))*\*\/)\s*)+\}/g
      ),
  },
  {
    id: "client-effect",
    label: "`useEffect` / `useLayoutEffect` calls in the inspector client",
    appliesTo: (path) => CLIENT_PATH.test(path),
    fix: "Derive the value during render, do the work in the event handler that causes it, reset state with a `key`, or subscribe with `useSyncExternalStore`. If an effect is the only option, replace an existing one in the same change.",
    count: (text) => countMatches(text, /\buse(?:Layout)?Effect\s*\(/g),
  },
  {
    id: "client-timer",
    label:
      "`setTimeout` / `setInterval` / `requestAnimationFrame` / `requestIdleCallback` calls in the inspector client",
    appliesTo: (path) => CLIENT_PATH.test(path),
    fix: "A timer that waits for React to commit or for state to settle hides an ordering bug. Act on the event or state change that makes the work possible.",
    count: (text) =>
      countMatches(
        text,
        /\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\s*\(/g
      ),
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
  {
    id: "workaround-comment",
    label:
      "comments that justify a workaround (hack, wait for React, next frame)",
    fix: "Fix the cause: act on the event or state change the code is waiting for, or fix the ordering. If a third-party bug forces the workaround, link the upstream issue in the same comment.",
    count: (text) =>
      countUnexemptCommentLines(text, WORKAROUND, UPSTREAM_ISSUE),
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
    label: "errors that open with a vague phrase (Oops, Something went wrong)",
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
