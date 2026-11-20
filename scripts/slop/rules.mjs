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

/**
 * `text` with comments and string literal contents removed, so a rule that
 * counts calls ignores a commented-out call or a call named inside a string.
 * Code inside a template literal's `${...}` is kept. A comment becomes a
 * space so the tokens on either side stay separate. A single-line regex
 * literal is blanked so a quote or backtick inside it opens nothing. JSX text
 * is not recognized; a stray quote there blanks at most the rest of its line,
 * which is rare enough to accept.
 */
function codeOnly(text) {
  let out = "";
  // One entry per open `${`: the brace depth inside that expression.
  const templates = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      out += " ";
    } else if (c === "/" && regexCanStart(out) && regexEnd(text, i) !== -1) {
      i = regexEnd(text, i);
      out += " ";
    } else if (c === '"' || c === "'") {
      i += 1;
      while (i < text.length && text[i] !== c && text[i] !== "\n") {
        i += text[i] === "\\" ? 2 : 1;
      }
      i += 1;
      out += " ";
    } else if (c === "`" || (c === "}" && templates.at(-1) === 0)) {
      if (c === "}") templates.pop();
      i += 1;
      while (i < text.length && text[i] !== "`") {
        if (text[i] === "\\") i += 2;
        else if (text.startsWith("${", i)) break;
        else i += 1;
      }
      if (text.startsWith("${", i)) {
        templates.push(0);
        i += 2;
      } else i += 1;
      out += " ";
    } else {
      const top = templates.length - 1;
      if (top >= 0 && c === "{") templates[top] += 1;
      if (top >= 0 && c === "}") templates[top] -= 1;
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Whether a `/` after `code` opens a regex literal instead of dividing. */
function regexCanStart(code) {
  let end = code.length;
  while (end > 0 && /\s/.test(code[end - 1])) end -= 1;
  const line = code.slice(code.lastIndexOf("\n", end - 1) + 1, end);
  // A prefix update cannot take a regex operand, so `++` or `--` here is
  // postfix and the slash divides. `a+++/re/` is `a++ + /re/`: odd runs end
  // in a binary operator.
  const run = /(?:\++|-+)$/.exec(line)?.[0].length ?? 0;
  if (run > 1) return run % 2 === 1;
  if (end === 0 || "(,=:[!&|?{};+-*%~^".includes(code[end - 1])) return true;
  // `of` is only a keyword in a for-of head; elsewhere it is an identifier.
  if (/\bof$/.test(line))
    return /\bfor\s*(?:await\s*)?\([^;()=]*of$/.test(line);
  return /\b(?:return|typeof|case|in|void|yield|await)$/.test(line);
}

/** Index just past the regex literal opening at `start`, or -1 if it does not close on its line. */
function regexEnd(text, start) {
  let inClass = false;
  for (let i = start + 1; i < text.length && text[i] !== "\n"; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === "[") inClass = true;
    else if (text[i] === "]") inClass = false;
    else if (text[i] === "/" && !inClass) return i + 1;
  }
  return -1;
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

/**
 * A hex color where a value starts: after a quote, a bracket (`bg-[#fff]`),
 * or a colon or comma. Not after a bare space, so prose such as
 * "order #4521" does not count.
 */
const HEX_COLOR =
  /(?<=["'`([]|[:,]\s*)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;

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
        /\bcatch\s*(?:\(\s*[\w${}\s,:]*\))?\s*\{\s*(?:(?:\/\/[^\n]*\n|\/\*(?:[^*]|\*(?!\/))*\*\/)\s*)+\}/g
      ),
  },
  {
    id: "client-effect",
    label: "`useEffect` / `useLayoutEffect` calls in the inspector client",
    appliesTo: (path) => CLIENT_PATH.test(path),
    fix: "Derive the value during render, do the work in the event handler that causes it, reset state with a `key`, or subscribe with `useSyncExternalStore`. If an effect is the only option, replace an existing one in the same change.",
    count: (text) =>
      countMatches(codeOnly(text), /\buse(?:Layout)?Effect\s*\(/g),
  },
  {
    id: "client-timer",
    label:
      "`setTimeout` / `setInterval` / `requestAnimationFrame` / `requestIdleCallback` calls in the inspector client",
    appliesTo: (path) => CLIENT_PATH.test(path),
    fix: "A timer that waits for React to commit or for state to settle hides an ordering bug. Act on the event or state change that makes the work possible.",
    count: (text) =>
      countMatches(
        codeOnly(text),
        /\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\s*\(/g
      ),
  },
  {
    id: "client-color-literal",
    label:
      "literal hex / `rgb()` / `hsl()` / `oklch()` colors in the inspector client",
    appliesTo: isClientColorCode,
    fix: "Use a role token from DESIGN.md: a Tailwind utility such as `bg-card`, `text-muted-foreground` or `border-border`, or `var(--success)` where a style object or SVG attribute needs a value. A color with no role goes into `design-system/src/tokens.css` first (then `npm run design:sync`).",
    count: (text) => {
      const code = stripComments(text);
      return countMatches(code, HEX_COLOR) + countMatches(code, COLOR_FUNCTION);
    },
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
      rule.appliesTo && !rule.appliesTo(path) ? 0 : rule.count(text);
  }
  return counts;
}
