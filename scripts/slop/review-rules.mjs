/**
 * Ratchet rules for bug classes that reviewers kept flagging on inspector PRs
 * and that a text count can find with few false positives. `rules.mjs`
 * spreads them into RULES, so the ratchet, the scorecard and the edit hook
 * enforce them like the rest.
 *
 * Both rules read code with comments and string contents blanked, so a call
 * named in a comment or inside generated source text does not count.
 */

/**
 * `text` with comments blanked to spaces, so offsets and line numbers still
 * match the source. With `blankStrings`, string, template and regex literal
 * contents become spaces too; their delimiters stay, so parentheses inside
 * them cannot unbalance a call. A template's `${...}` expressions are blanked
 * with it: a call inside one is rare and not worth a parser.
 */
export function stripComments(text, { blankStrings = false } = {}) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && (next === "/" || next === "*")) {
      const stop = commentEnd(text, i);
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (
      c === '"' ||
      c === "'" ||
      c === "`" ||
      isRegexStart(out, text, i)
    ) {
      const stop = literalEnd(text, i);
      out += blankStrings
        ? c +
          text
            .slice(i + 1, stop)
            .replace(/[^\n]/g, " ")
            .slice(0, -1) +
          text[stop - 1]
        : text.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function commentEnd(text, start) {
  if (text[start + 1] === "/") {
    const end = text.indexOf("\n", start);
    return end === -1 ? text.length : end;
  }
  const end = text.indexOf("*/", start + 2);
  return end === -1 ? text.length : end + 2;
}

/** A `/` opens a regex literal after an operator or a keyword, and only if it closes on its line. */
function isRegexStart(code, text, i) {
  if (text[i] !== "/") return false;
  const before = code.slice(-24).replace(/[ \t]+$/, "");
  const last = before[before.length - 1];
  const opens =
    last === undefined ||
    "(,=:[!&|?{};\n".includes(last) ||
    /\b(?:return|typeof|case|in|of|void|yield|await)$/.test(before);
  return opens && regexClose(text, i) !== -1;
}

function regexClose(text, start) {
  let inClass = false;
  for (let i = start + 1; i < text.length && text[i] !== "\n"; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === "[") inClass = true;
    else if (text[i] === "]") inClass = false;
    else if (text[i] === "/" && !inClass) return i;
  }
  return -1;
}

/**
 * Index just past the string, template or regex literal opening at `start`.
 * A template's `${...}` is skipped to its matching brace, so a nested
 * template inside it does not end the outer one.
 */
function literalEnd(text, start) {
  const quote = text[start];
  if (quote === "/") return regexClose(text, start) + 1;
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === quote) return i + 1;
    // An unterminated quote ends at the line break, where the parser fails too.
    else if (c === "\n" && quote !== "`") return i;
    else if (quote === "`" && c === "$" && text[i + 1] === "{") {
      i = expressionEnd(text, i + 2);
    } else i += 1;
  }
  return text.length;
}

/** Index just past the `}` that closes a template expression starting at `start`. */
function expressionEnd(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") i = literalEnd(text, i);
    else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = commentEnd(text, i);
    } else {
      if (c === "{") depth += 1;
      else if (c === "}" && depth-- === 0) return i + 1;
      i += 1;
    }
  }
  return text.length;
}

/** The text between the parenthesis at `open` and its match, or the rest of `code`. */
function callArgs(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if ("([{".includes(code[i])) depth += 1;
    else if (")]}".includes(code[i])) {
      depth -= 1;
      if (depth === 0) return { args: code.slice(open + 1, i), end: i + 1 };
    }
  }
  return { args: code.slice(open + 1), end: code.length };
}

function splitTopLevel(args) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const c of args) {
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

const FETCH_CALL =
  /(?<![\w$.])(?:(?:globalThis|window|self)\s*\.\s*)?fetch\s*\(/g;

/** What may precede a method named `fetch`: a body or member list opening, or a modifier. */
const MEMBER_START = /(?:^|[{};,]|\b(?:static|public|private|protected))\s*$/;

/**
 * Offsets of `fetch()` calls that pass no `signal`. A call whose options are
 * a variable, a call or a spread is skipped, since the signal may be inside
 * it, and so is a pass-through `fetch(...args)`; the rule only counts calls
 * where the missing signal is visible. A method named `fetch` (a Worker's
 * `fetch(request) {`) is a definition, not a call.
 */
export function fetchCallsWithoutSignal(text) {
  const code = stripComments(text, { blankStrings: true });
  const offsets = [];
  for (const match of code.matchAll(FETCH_CALL)) {
    const before = code.slice(Math.max(0, match.index - 20), match.index);
    if (/\b(?:function|async)\s*$/.test(before)) continue;
    const { args, end } = callArgs(code, match.index + match[0].length - 1);
    if (
      MEMBER_START.test(before) &&
      /^\s*[{:]/.test(code.slice(end, end + 40))
    ) {
      continue;
    }
    if (/\bsignal\b/.test(args)) continue;
    const parts = splitTopLevel(args);
    if (parts.some((part) => /^\s*\.\.\./.test(part))) continue;
    const init = parts[1];
    if (init !== undefined && (!/^\s*\{/.test(init) || /\.\.\./.test(init))) {
      continue;
    }
    offsets.push(match.index);
  }
  return offsets;
}

const CHILD_PROCESS_IMPORT =
  /["'](?:node:)?child_process["']|["']cross-spawn["']/;

const SPAWN_CALL =
  /(?<![\w$.])(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:spawn|fork)\s*\(/g;

/**
 * The variable a call at the end of `before` is assigned to: `const child =`,
 * `let child: ChildProcess =`, `child =` or `this.child =`.
 */
const ASSIGNED_TO =
  /(?:\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?|(?<![\w$.])((?:this\s*\.\s*)?[A-Za-z_$][\w$]*))\s*=\s*(?:await\s+)?$/;

function listenerPattern(name) {
  const target = name
    .replace(/\s+/g, "")
    .replace(/[$.]/g, "\\$&")
    .replace("\\.", "\\s*\\.\\s*");
  const event = "\\s*[\"'`]error[\"'`]";
  return new RegExp(
    `(?<![\\w$])${target}\\s*\\??\\.\\s*(?:on|once|addListener|prependListener|prependOnceListener)\\s*\\(${event}` +
      `|(?<![\\w$.])(?:once|on)\\s*\\(\\s*${target}\\s*,${event}`,
  );
}

/**
 * Child processes from `spawn` or `fork`, held in a variable, with no `error`
 * listener on that variable. Node emits `error` when the binary is missing or
 * the process cannot start, and an emitter with no listener throws it, so the
 * caller's close or exit handler never runs. A child returned or passed on
 * without a variable is skipped: whoever receives it may listen.
 */
export function countSpawnWithoutErrorListener(text) {
  if (!CHILD_PROCESS_IMPORT.test(text)) return 0;
  const code = stripComments(text, { blankStrings: true });
  const withStrings = stripComments(text);
  let count = 0;
  for (const match of code.matchAll(SPAWN_CALL)) {
    const before = code.slice(Math.max(0, match.index - 200), match.index);
    const assigned = ASSIGNED_TO.exec(before);
    if (!assigned) continue;
    const { end } = callArgs(code, match.index + match[0].length - 1);
    // `spawn(...).on("error", ...)` assigns the child after listening.
    const chained = withStrings.slice(end, end + 200);
    if (/^\s*\.\s*(?:on|once)\s*\(\s*["'`]error["'`]/.test(chained)) continue;
    const name = assigned[1] ?? assigned[2];
    if (!listenerPattern(name).test(withStrings)) count += 1;
  }
  return count;
}

export const REVIEW_RULES = [
  {
    id: "fetch-without-signal",
    label: "`fetch()` calls with no `signal`",
    fix: "Pass `signal: AbortSignal.timeout(ms)`, or the caller's signal combined with one through `AbortSignal.any`, so a server that never answers cannot hold the request open.",
    count: (text) => fetchCallsWithoutSignal(text).length,
  },
  {
    id: "spawn-without-error-listener",
    label: "spawned child processes with no `error` listener",
    fix: 'Add `child.on("error", ...)` that settles the caller\'s promise and cleans up. Without it a missing binary or a failed start throws from the emitter instead of reaching your exit handler.',
    count: countSpawnWithoutErrorListener,
  },
];
