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

function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

/** The offending `file:line` positions in one file's source. */
export function findLegacyProjectQueryWriters(source: string): number[] {
  const lines = source.split("\n");
  const hits = new Set<number>();

  for (const [index, line] of lines.entries()) {
    // Writers only. A comment, or a reader like
    // `searchParams.get("project")`, is fine.
    if (isCommentLine(line)) continue;
    if (LINE_WRITER_PATTERNS.some((pattern) => pattern.test(line))) {
      hits.add(index + 1);
    }
  }

  for (const pattern of SOURCE_WRITER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const line = lineOfOffset(source, match.index);
      // The constructor opening inside a comment is a doc example, not a call.
      if (!isCommentLine(lines[line - 1] ?? "")) hits.add(line);
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
      [" * new URLSearchParams({", " *   project: id,", " * });"].join("\n"),
    ],
  ])("stays quiet on %s", (_shape, source) => {
    expect(findLegacyProjectQueryWriters(source)).toEqual([]);
  });
});
