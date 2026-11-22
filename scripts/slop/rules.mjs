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

/**
 * Comments blanked out, line breaks kept. Comments cite issues (`#5104`) and
 * describe colors without rendering them. A `//` after a `:` or a quote is
 * left alone so URLs in strings survive.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/gm, "$1");
}

const HEX = "#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\\w-])";

/**
 * A hex color in a string whose role is a color, alone or after a space
 * (`"1px solid #e4e4e7"`).
 */
const HEX_VALUE = new RegExp(`(?<![^\\s(,:[_])${HEX}`, "g");

/** A string that is one hex color and nothing else. */
const HEX_ONLY = new RegExp(`^\\s*${HEX}\\s*$`);

/**
 * A hex color in any string where CSS or Tailwind holds it: a Tailwind
 * arbitrary value (`bg-[#fff]`) or a color-bearing CSS declaration
 * (`border: 1px solid #ccc`, `--host-bg: #000`).
 */
const HEX_IN_CSS = new RegExp(
  `(?:[[_]|(?:^|[\\s;{])(?:--[\\w-]+|[a-z-]*(?:color|background|border|fill|stroke|shadow|outline)[a-z-]*)\\s*:[^;:]*?)${HEX}`,
  "g",
);

/** Words in a prop, property or variable name that say it holds colors or classes. */
const COLOR_WORDS = new Set(
  "color colors colour colours fill stroke background bg fg foreground border shadow outline ring tint accent palette theme style styles class gradient stop glow hue".split(
    " ",
  ),
);

/** Words in a name that say a `#...` value is a link, an id or a label. */
const NOT_COLOR_WORDS = new Set(
  "href to id hash anchor target key label title alt placeholder path url link route selector".split(
    " ",
  ),
);

/**
 * A color function with a literal first channel; `hsl(var(--x))` is a token.
 * `_` may precede it, as inside `shadow-[0_1px_2px_rgba(0,0,0,0.3)]`.
 */
const COLOR_FUNCTION =
  /(?<![A-Za-z0-9-])(?:rgba?|hsla?|oklch|oklab|lch|lab|hwb)\(\s*[\d.]/g;

/** A Tailwind color utility on the default palette, with any variant prefix. */
const PALETTE_CLASS =
  /(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|divide|from|via|to|fill|stroke|decoration|placeholder|caret|accent|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/g;

/**
 * Other hosts' design tokens, host styles and brand tints (ChatGPT, Claude,
 * ...), copied verbatim so a widget and its host chrome look as they do
 * there. They define someone else's palette, so MCPJam's roles cannot
 * replace them, and adding a host template must not trip the ratchet.
 */
const HOST_PALETTE_PATH =
  /^mcpjam-inspector\/client\/src\/(?:config\/[\w-]+-client-context\.ts$|lib\/client-styles\/|lib\/host-ui-metadata\.ts$)/;

const isClientColorCode = (path) =>
  CLIENT_PATH.test(path) && !HOST_PALETTE_PATH.test(path);

/**
 * The lower-case words of the names a string is assigned to (`termBg` gives
 * `term`, `bg`), from the nearest name out to its statement.
 */
function roleWords(node) {
  const ts = typescript();
  const words = [];
  for (let at = node.parent; at && !ts.isStatement(at); at = at.parent) {
    if (ts.isFunctionLike(at) || ts.isSourceFile(at)) break;
    const name =
      ts.isPropertyAssignment(at) ||
      ts.isJsxAttribute(at) ||
      ts.isVariableDeclaration(at) ||
      ts.isParameter(at)
        ? at.name
        : ts.isBinaryExpression(at) &&
            at.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? at.left
          : undefined;
    if (!name) continue;
    const spaced = name.getText().replace(/([a-z\d])([A-Z])/g, "$1 $2");
    words.push(...spaced.toLowerCase().split(/[^a-z\d]+/).filter(Boolean));
  }
  return words;
}

/**
 * Literal colors in the strings and template text of a JS/TS/JSX/TSX file.
 * Comments and JSX text are prose, so "order #4521" there never counts. A
 * hex counts where CSS holds it, in a string whose name says it holds colors
 * or classes, or as a whole string unless its name says it is a link, an id
 * or a label, so `href="#feed"` and `"Order: #4521"` do not count.
 */
function countColorLiterals(path, text) {
  const ts = typescript();
  let count = 0;
  walk(parse(path, text), (node) => {
    if (!ts.isStringLiteralLike(node) && !ts.isTemplateLiteralToken(node)) {
      return;
    }
    const value = node.text;
    const words = roleWords(node);
    if (words.some((word) => COLOR_WORDS.has(word))) {
      count += countMatches(value, HEX_VALUE);
    } else if (HEX_ONLY.test(value)) {
      if (!words.some((word) => NOT_COLOR_WORDS.has(word))) count += 1;
    } else count += countMatches(value, HEX_IN_CSS);
    count += countMatches(value, COLOR_FUNCTION);
  });
  return count;
}

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
    id: "client-color-literal",
    label:
      "literal hex / `rgb()` / `hsl()` / `oklch()` colors in inspector client JS/TS (stylesheets are not read)",
    appliesTo: isClientColorCode,
    fix: "Use a role token from DESIGN.md: a Tailwind utility such as `bg-card`, `text-muted-foreground` or `border-border`, or `var(--success)` where a style object or SVG attribute needs a value. A color with no role goes into `design-system/src/tokens.css` first (then `npm run design:sync`).",
    count: (text, path) => countColorLiterals(path, text),
  },
  {
    id: "client-palette-class",
    label:
      "raw Tailwind palette classes (`bg-red-500`) in the inspector client",
    appliesTo: isClientColorCode,
    fix: "Use the role class instead: `bg-destructive/10 text-destructive` for errors, `text-success`, `text-warning`, `text-info`, `bg-muted text-muted-foreground` for neutral grays. Roles carry their dark-mode value, so no `dark:` twin is needed.",
    count: (text) => countMatches(stripComments(text), PALETTE_CLASS),
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
