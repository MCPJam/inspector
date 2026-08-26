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
 * The shapes a `project` query field is actually written in. Interpolation and
 * a bare literal were the obvious two; the rest are the ways the same thing
 * gets written when nobody is looking at this test — a `URLSearchParams`
 * setter, an object literal handed to its constructor, single quotes, and a
 * concatenation.
 */
const WRITER_PATTERNS: readonly RegExp[] = [
  // `?project=${id}` / `&project=${id}`
  /[?&]project=\$\{/,
  // A `?project=`/`&project=` that ENDS a string literal — the concatenated
  // form (`"/servers?project=" + id`) as well as a bare `"?project="`.
  /[?&]project=["'`]/,
  // `params.set("project", …)` / `.append('project', …)`
  /\.(?:set|append)\(\s*["'`]project["'`]\s*,/,
  // `new URLSearchParams({ project: … })`. Anchored to the constructor on
  // purpose: a bare `project:` field matches every options bag and dispatch
  // payload in the app, and a guard that cries wolf gets deleted.
  /URLSearchParams\(\s*\{[^}]*\bproject\s*:/,
];

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
      for (const [index, line] of source.split("\n").entries()) {
        // Writers only. A comment, or a reader like
        // `searchParams.get("project")`, is fine.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (WRITER_PATTERNS.some((pattern) => pattern.test(line))) {
          offenders.push(`${file.slice(CLIENT_SRC.length + 1)}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
