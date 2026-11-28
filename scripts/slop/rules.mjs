/**
 * The slop patterns the ratchet counts. `measure.mjs` reports them across the
 * repo, `ratchet.mjs` fails a PR whose changed files add more than they
 * remove, and `check-file.mjs` reports them on one file as an agent edits it.
 * All three read this list, so a rule added here is enforced everywhere.
 *
 * Most are text counts. A rule that has to tell code from comments, strings
 * or JSX text reads the syntax tree from `parse.mjs`. A rule earns its place
 * by being cheap, stable and hard to hit by accident; anything that needs
 * types belongs in ESLint instead.
 */

import { parse, typescript, walk } from "./parse.mjs";
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

const EFFECTS = new Set(["useEffect", "useLayoutEffect"]);

const TIMERS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
]);

/**
 * Calls to one of `names`, bare or as a member (`window.setTimeout`). They
 * are read from the syntax tree, so a call named in a comment, a string, a
 * regex literal or JSX text does not count.
 */
function countCalls(path, text, names) {
  const { isCallExpression, isIdentifier, isPropertyAccessExpression } =
    typescript();
  let count = 0;
  walk(parse(path, text), (node) => {
    if (!isCallExpression(node)) return;
    const callee = isPropertyAccessExpression(node.expression)
      ? node.expression.name
      : node.expression;
    if (isIdentifier(callee) && names.has(callee.text)) count += 1;
  });
  return count;
}

/** `catch` clauses whose block has no statement but has a comment. */
function countCommentOnlyCatches(path, text) {
  const { isCatchClause } = typescript();
  let count = 0;
  walk(parse(path, text), (node) => {
    if (!isCatchClause(node) || node.block.statements.length) return;
    // A block with no statement holds only whitespace and comments.
    if (/\S/.test(text.slice(node.block.getStart() + 1, node.block.end - 1))) {
      count += 1;
    }
  });
  return count;
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
 * tick, or a cause nobody understood. A hack or workaround that the comment
 * says is avoided ("not", "without", "prevent") does not count.
 */
const WORKAROUND =
  /(?<!\b(?:not|no|without|avoid(?:s|ed|ing)?|prevent(?:s|ed|ing)?)\b[^.]{0,30})\b(?:hack(?:s|y|ish)?|workarounds?)\b|\b(?:wait|yield|defer|delay)(?:s|ed|ing)?\b[^.]{0,40}\b(?:React|the DOM|the browser)\b[^.]{0,30}\b(?:commit|flush|paint|render|settle|catch(?:es)? up)|\b(?:wait|yield|defer|delay)(?:s|ed|ing)?\b[^.]{0,30}\b(?:one|a|the next|another) (?:frame|tick|paint)\b|\b(?:for (?:some|whatever) reason|no idea why|not sure why)\b/i;

/**
 * A comment that admits a compromise: a failure tolerated (a swallowed
 * error), a guard for a case believed impossible (belt-and-braces, or a
 * defensive guard beside `NOT_EXPECTED`), or a shortcut taken on purpose
 * (deliberately loose, lossy or duplicated). "Best-effort" is left out: it is
 * the usual name here for a fallback chosen on purpose. The bare words
 * "deliberately", "intentionally" and "swallow" mostly explain real decisions
 * or describe input handling here, so each is matched only next to the words
 * that make it a concession.
 */
const COMPROMISE =
  /(?<!\bnot (?:a |as )?)\bbelt[- ]and[- ](?:braces|suspenders)\b|\b(?:deliberately|intentionally|on purpose)\W+(?:swallow(?:s|ed|ing)?|loose|lossy|duplicat(?:e|es|ed|ing)|(?:ignor(?:e|es|ed|ing)|skip(?:s|ped|ping)?)\W+(?:the |any |this |that |its |a )?(?:errors?|failures?|rejections?|exceptions?|throws?))\b|\bswallow(?:s|ed|ing)?\W+(?:on purpose|deliberately|intentionally)\b|^\s*(?:\/\/|\/\*)\s*swallow\b/i;

const DEFENSIVE =
  /(?<!\bnot (?:a |as )?)\bdefensive(?::|(?:ly)?\s+(?:guard|branch|check|fallback|invariant|default|catch|continue|skip|clamp|re-?check|no-?op|mixed-version)(?:s|es|ed)?\b)/;

/**
 * A claim that the guarded case does not happen. "Defensive check for null"
 * only says what a check does; the same line saying null cannot get there is
 * what makes the guard a concession instead of handling a real input.
 */
const NOT_EXPECTED =
  /\bshould(?:n't|\s+not|\s+never)\b|\bnever\s+(?:happens?|throws?|occurs?|reach(?:es|ed)?)\b|\b(?:can(?:'t|not)|won't)\s+happen\b|\b(?:unreachable|impossible|unexpected|in practice)\b|\bjust\s+in\s+case\b|\b(?:already|should be)\s+(?:guarded|covered|handled|checked|validated|filtered|rejected|caught|ruled out)\b|\b(?:types?|callers?|schemas?|validators?)\s+(?:already\s+)?(?:reject|rule out|prevent|guarantee|exclude)/;

const WORKAROUND_OR_COMPROMISE = new RegExp(
  `${WORKAROUND.source}|${COMPROMISE.source}|(?:${DEFENSIVE.source}).*(?:${NOT_EXPECTED.source})|(?:${NOT_EXPECTED.source}).*(?:${DEFENSIVE.source})`,
  "i",
);

/**
 * A link to one third-party bug: an issue or PR number outside `MCPJam/`, or
 * a bug id. A workaround forced by someone else's bug cannot be fixed here,
 * and the link is how a reader knows when to remove it. A tracker's home or
 * docs page names no bug, and our own issues are ours to fix.
 */
const UPSTREAM_ISSUE =
  /https?:\/\/(?!(?:www\.)?github\.com\/mcpjam\/)[^\s"'`)>\]]*?(?:\/(?:issues|pull|bugs?)\/\d+|[?&]id=\d+|crbug\.com\/\d+)/i;

const INDENT = /[ \t]*/y;

/**
 * Lines whose first character sits in a real comment, read from the syntax
 * tree so a `//` inside a string, a template or JSX text is not one. The
 * scan runs before and after every node and inside every bracket, which
 * also reaches a comment before a closing brace, where no node starts.
 */
function commentLineNumbers(path, text) {
  const ts = typescript();
  const tree = parse(path, text);
  const ranges = new Map();
  const jsxText = [];
  const scan = (pos) => {
    for (const range of ts.getLeadingCommentRanges(text, pos) ?? []) {
      ranges.set(range.pos, range);
    }
  };
  walk(tree, (node) => {
    if (ts.isJsxText(node)) {
      jsxText.push(node);
      return;
    }
    scan(node.pos);
    scan(node.end);
    const start = node.getStart(tree);
    if (!ts.isToken(node) && "{([".includes(text[start])) scan(start + 1);
  });
  const lineStarts = tree.getLineStarts();
  const lines = new Set();
  for (const { pos, end } of ranges.values()) {
    if (jsxText.some((node) => pos >= node.pos && pos < node.end)) continue;
    const first = tree.getLineAndCharacterOfPosition(pos).line;
    const last = tree.getLineAndCharacterOfPosition(end).line;
    for (let line = first; line <= last; line += 1) {
      INDENT.lastIndex = lineStarts[line];
      const at = lineStarts[line] + INDENT.exec(text)[0].length;
      if (at >= pos && at < end) lines.add(line);
    }
  }
  return lines;
}

/**
 * Comment lines matching `regex`, except in a run of comment lines that links
 * `exempt`. Each line is matched on its own, so a claim split across two
 * lines ("Defensive check" / "This cannot happen") does not count.
 */
function countUnexemptCommentLines(path, text, regex, exempt) {
  const comments = commentLineNumbers(path, text);
  let count = 0;
  let block = 0;
  let exempted = false;
  for (const [index, line] of text.split("\n").entries()) {
    if (!comments.has(index)) {
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
    fix: "Propagate the error, or return a failure the caller can tell apart from success. Log it only where the code falls back on purpose, and say what the fallback is.",
    count: (text, path) => countCommentOnlyCatches(path, text),
  },
  {
    id: "client-effect",
    label: "`useEffect` / `useLayoutEffect` calls in the inspector client",
    appliesTo: (path) => CLIENT_PATH.test(path),
    fix: "Derive the value during render, do the work in the event handler that causes it, reset state with a `key`, or subscribe with `useSyncExternalStore`. If an effect is the only option, replace an existing one in the same change.",
    count: (text, path) => countCalls(path, text, EFFECTS),
  },
  {
    id: "client-timer",
    label:
      "`setTimeout` / `setInterval` / `requestAnimationFrame` / `requestIdleCallback` calls in the inspector client",
    appliesTo: (path) => CLIENT_PATH.test(path),
    fix: "A timer that waits for React to commit or for state to settle hides an ordering bug. Act on the event or state change that makes the work possible.",
    count: (text, path) => countCalls(path, text, TIMERS),
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
      "comments that justify a workaround or compromise (hack, wait for React, swallowed error, defensive guard)",
    fix: "Fix the cause instead of explaining it: act on the event or state change the code is waiting for, handle or surface the failure instead of swallowing it, and drop a guard for a case the types or callers already rule out. If a third-party bug forces the workaround, link the upstream issue in the same comment.",
    count: (text, path) =>
      countUnexemptCommentLines(
        path,
        text,
        WORKAROUND_OR_COMPROMISE,
        UPSTREAM_ISSUE,
      ),
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
      rule.appliesTo && !rule.appliesTo(path) ? 0 : rule.count(text, path);
  }
  return counts;
}
