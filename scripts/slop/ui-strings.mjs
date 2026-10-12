/**
 * User-facing copy in UI source: the string literals and JSX text a person
 * reads in the product. `rules.mjs` counts slop patterns in it and
 * `copy-review.mjs` sends what a PR adds to Claude for review.
 *
 * This is a small tokenizer, not a parser. It tracks comments, strings,
 * template literals and regex literals so an apostrophe in JSX text or a
 * quote in a comment cannot derail the scan. Copy is any string of two or
 * more words that reads as a label or sentence; class names, paths, log
 * messages and identifiers are dropped by shape and by the code before them.
 */

const UI_PATH =
  /^(?:mcpjam-inspector\/client\/src|chat-ui\/src|widget-react\/src|design-system\/src)\/.*\.tsx?$/;

/** Packages whose strings reach a screen. Server and CLI text is out of scope. */
export function isUiFile(path) {
  return UI_PATH.test(path);
}

/** The code right before a string that says it is not copy. */
const NOT_COPY_BEFORE =
  /(?:^|[^\w.$])(?:className|class|cn|cva|clsx|twMerge|tw|data-[\w-]+|testId|key|id|href|src|to|from|import|export|require|type|variant|size|name|kind|event|track|capture|typeof|case|console\.\w+|logger\.\w+|log\.\w+|debug|trace|describe|it|test)\s*[(=:,]?\s*$/;

/** Code before `>` that makes it the end of a JSX tag rather than an operator. */
const TAG_BEFORE = /<\/?[A-Za-z][\w.:-]*(?:[^<>]|=>)*$/;

/** Inside a JSX-text candidate, these mean it was code after an operator. */
const JSX_CODE = /\/\/|\/\*|[[\]]|\n\s*\w+\s*:/;

/** Code before `/` that makes it the start of a regex literal. */
const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};]|return|typeof|case|=>)\s*$/;

/** Two or more words that read as prose: not a path, a class list or code. */
export function looksLikeCopy(text) {
  const t = text.trim();
  if (t.length < 4 || !/\s/.test(t) || !/[A-Za-z]{2}/.test(t)) return false;
  if (/^(?:https?:|\.{0,2}\/|@|#|\$\{)/.test(t)) return false;
  // Tailwind classes and other lowercase token lists: no sentence punctuation.
  if (/^[a-z0-9:[\]/\-.%#()!,\s]+$/.test(t) && !/[.?!](?:\s|$)/.test(t)) {
    return false;
  }
  if (/=>|&&|\|\||[=;]/.test(t)) return false;
  if (/^[A-Z0-9_]+(?:\s+[A-Z0-9_]+)*$/.test(t)) return false;
  return true;
}

/** Skip a `${ ... }` expression, honoring nested braces and strings. */
function skipExpression(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(text, i, c) - 1;
    }
  }
  return text.length;
}

function skipQuoted(text, start, quote) {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === quote) return i + 1;
    else if (quote === "`" && text.startsWith("${", i)) {
      i = skipExpression(text, i + 1) - 1;
    } else if (quote !== "`" && text[i] === "\n") return i;
  }
  return text.length;
}

/**
 * Every string of copy in `text` with the line it starts on. Template
 * literals keep their `${...}` expressions verbatim so a reviewer sees what
 * varies; JSX text is collapsed to single spaces.
 */
export function extractUiStrings(text) {
  const found = [];
  // Code seen so far with strings and comments removed, for the look-behind
  // regexes above. Only the tail matters, so it is trimmed as it grows.
  let code = "";
  let line = 1;
  let i = 0;
  const record = (raw, at) => {
    if (looksLikeCopy(raw) && !NOT_COPY_BEFORE.test(code.slice(-80))) {
      found.push({ line: at, text: raw.replace(/\s+/g, " ").trim() });
    }
  };
  const advance = (to) => {
    for (let j = i; j < to; j += 1) if (text[j] === "\n") line += 1;
    i = to;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      advance(text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i));
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      advance(end === -1 ? text.length : end + 2);
    } else if (c === '"' || c === "'" || c === "`") {
      const end = skipQuoted(text, i, c);
      const at = line;
      record(text.slice(i + 1, text[end - 1] === c ? end - 1 : end), at);
      advance(end);
      code += "S";
    } else if (c === "/" && REGEX_BEFORE.test(code.slice(-40))) {
      let j = i + 1;
      for (; j < text.length && text[j] !== "\n"; j += 1) {
        if (text[j] === "\\") j += 1;
        else if (text[j] === "[") j = Math.max(j, text.indexOf("]", j));
        else if (text[j] === "/") break;
      }
      advance(j + 1);
      code += "R";
    } else if (c === ">" && text[i - 1] !== "=" && TAG_BEFORE.test(code.slice(-200))) {
      // JSX text runs from a tag to the next tag or expression. Anything
      // else after `>` (a call, an operator) is code and is scanned as such.
      const match = /^([^<{}>;]*)[<{]/.exec(text.slice(i + 1, i + 2000));
      code += c;
      i += 1;
      if (match && looksLikeCopy(match[1]) && !JSX_CODE.test(match[1])) {
        const at = line;
        advance(i + match[1].length);
        found.push({ line: at, text: match[1].replace(/\s+/g, " ").trim() });
      }
    } else {
      if (c === "\n") line += 1;
      code += c;
      i += 1;
    }
    if (code.length > 400) code = code.slice(-200);
  }
  return found;
}

/**
 * Copy present in `after` and not in `before`, by text. Moving a string
 * within a file or re-indenting its JSX does not count as new copy.
 */
export function addedCopy(before, after) {
  const seen = new Map();
  for (const { text } of extractUiStrings(before)) {
    seen.set(text, (seen.get(text) ?? 0) + 1);
  }
  const added = [];
  for (const item of extractUiStrings(after)) {
    const left = seen.get(item.text) ?? 0;
    if (left > 0) seen.set(item.text, left - 1);
    else added.push(item);
  }
  return added;
}
