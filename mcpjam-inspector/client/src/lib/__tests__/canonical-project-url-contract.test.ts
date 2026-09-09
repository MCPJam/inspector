import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The write side of the migration, guarded by a grep.
 *
 * Reading `?project=` is supported for at least one full release — old links
 * exist in CI logs, Slack messages and bookmarks. MINTING it is over: a query
 * parameter the app consumes and strips leaves a URL that no longer says
 * which project it belongs to, which is the whole failure canonical paths
 * remove. A new one would not fail any test on its own; it would just quietly
 * reintroduce the bug for one surface.
 */
const CLIENT_SRC = join(__dirname, "..", "..");

/** Where reading (and documenting) the legacy parameter is still the job. */
const ALLOWED = new Set([
  join(CLIENT_SRC, "lib", "project-route.ts"),
  join(CLIENT_SRC, "lib", "project-deep-link.ts"),
  join(CLIENT_SRC, "components", "routing", "legacy-project-route-normalizer.tsx"),
]);

/**
 * The shapes a `project` query field is written in that fit on one line:
 * interpolation, a bare literal ending a string, and the `URLSearchParams`
 * setters. The object-literal constructor is handled separately below —
 * it is the one that does not stay on a line.
 */
const LINE_WRITER_PATTERNS: readonly RegExp[] = [
  // `?project=${id}` / `&project=${id}`
  /[?&]project=\$\{/,
  // A `?project=`/`&project=` that ENDS a string literal — the concatenated
  // form (`"/servers?project=" + id`) as well as a bare `"?project="`.
  /[?&]project=["'`]/,
  // `params.set("project", …)` / `.append('project', …)`
  /\.(?:set|append)\(\s*["'`]project["'`]\s*,/,
];

/**
 * Matched against the whole file rather than a line at a time, because the
 * shape it looks for is routinely split across lines by the formatter:
 *
 *   new URLSearchParams({
 *     project: projectId,
 *   })
 *
 * `[^}]` already spans newlines — the old per-line scan was what confined it
 * to one line, so a prettier-wrapped writer slipped straight past the guard.
 *
 * Still anchored to the constructor on purpose: a bare `project:` field
 * matches every options bag and dispatch payload in the app, and a guard that
 * cries wolf gets deleted.
 */
const SOURCE_WRITER_PATTERNS: readonly RegExp[] = [
  /URLSearchParams\(\s*\{[^}]*\bproject\s*:/g,
];

/** 1-based line number of a character offset, for the offender list. */
function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Blank out comments, keeping every other byte (and every newline) in place so
 * offsets and line numbers still line up with the real file.
 *
 * The previous version asked "does the line this match STARTS on look like a
 * comment?", which is right for `//` and for a JSDoc body but wrong for a
 * plain block comment: in
 *
 *   an unstarred block-comment body — the opener on its own line, then
 *   `new URLSearchParams({`, then `project: id,` —
 *
 * the constructor starts on a line that looks like ordinary code, so disabled
 * code and documentation were reported as violations. A guard that fails an
 * unrelated PR gets deleted, so it has to know where comments actually end.
 *
 * Strings are tracked but NOT blanked — the patterns match inside string
 * literals, which is the whole point (`"/servers?project=" + id`). Tracking
 * them is what keeps the `//` in `"https://example.com"` from opening a
 * comment. Regex literals are not tracked: `/*` and `//` cannot begin one in
 * valid JS, so there is nothing for them to swallow.
 */
function blankComments(source: string): string {
  const out = source.split("");
  let quote: string | null = null;
  let index = 0;

  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  while (index < source.length) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    index += 1;
  }

  return out.join("");
}

/** The offending `file:line` positions in one file's source. */
export function findLegacyProjectQueryWriters(source: string): number[] {
  const code = blankComments(source);
  const hits = new Set<number>();

  // Writers only. A reader like `searchParams.get("project")` is fine, and
  // anything inside a comment is already blank by here.
  for (const [index, line] of code.split("\n").entries()) {
    if (LINE_WRITER_PATTERNS.some((pattern) => pattern.test(line))) {
      hits.add(index + 1);
    }
  }

  for (const pattern of SOURCE_WRITER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      hits.add(lineOfOffset(code, match.index));
    }
  }

  return [...hits].sort((a, b) => a - b);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (/\.(ts|tsx)$/.test(full)) yield full;
  }
}

describe("no first-party client code mints ?project=", () => {
  it("finds no new legacy project-query writers", () => {
    const offenders: string[] = [];
    for (const file of walk(CLIENT_SRC)) {
      if (ALLOWED.has(file)) continue;
      const source = readFileSync(file, "utf8");
      for (const line of findLegacyProjectQueryWriters(source)) {
        offenders.push(`${file.slice(CLIENT_SRC.length + 1)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The guard is only worth having if it fires, so pin the shapes it must
   * catch — including the one it used to miss.
   */
  it.each([
    ["template interpolation", 'navigate(`/servers?project=${id}`);'],
    ["string concatenation", 'navigate("/servers?project=" + id);'],
    ["single-quoted setter", "params.set('project', id);"],
    ["append setter", 'params.append("project", id);'],
    ["inline constructor", "new URLSearchParams({ project: id });"],
    [
      "constructor wrapped by the formatter",
      ["const params = new URLSearchParams({", "  project: id,", "});"].join(
        "\n"
      ),
    ],
    [
      "a writer on the line after a block comment closes",
      "/* disabled\n*/ navigate(`/servers?project=${id}`);",
    ],
    [
      "a writer in a string that also contains a //",
      'navigate("https://app.dev/servers?project=" + id);',
    ],
  ])("catches a writer spelled as %s", (_shape, source) => {
    expect(findLegacyProjectQueryWriters(source)).not.toEqual([]);
  });

  /**
   * And only worth having if it stays quiet, otherwise it gets deleted the
   * first time it blocks an unrelated PR.
   */
  it.each([
    ["a reader", 'const id = params.get("project");'],
    ["an options bag", "dispatch({ project: id, tab: 'servers' });"],
    [
      "a multiline options bag",
      ["track(evt, {", "  project: id,", "});"].join("\n"),
    ],
    ["a commented-out writer", '// navigate(`/servers?project=${id}`);'],
    [
      "a doc example of the constructor",
      [
        "/**",
        " * new URLSearchParams({",
        " *   project: id,",
        " * });",
        " */",
      ].join("\n"),
    ],
    [
      "a block comment whose body is not starred",
      [
        "/*",
        "new URLSearchParams({",
        "  project: id,",
        "});",
        "navigate(`/servers?project=${id}`);",
        "*/",
      ].join("\n"),
    ],
    [
      "a trailing block comment on a line of real code",
      "const x = 1; /* new URLSearchParams({ project: id }) */",
    ],
    ["a URL whose scheme carries a //", 'const base = "https://x.dev/servers";'],
  ])("stays quiet on %s", (_shape, source) => {
    expect(findLegacyProjectQueryWriters(source)).toEqual([]);
  });
});
