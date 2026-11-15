/**
 * Which tests a pull request needs (test.yml and lint.yml's `scope` job).
 *
 * A PR runs the tests its diff can affect; Release runs every test on the
 * commit it ships (release.yml calls test.yml and lint.yml), which catches
 * whatever this narrower run misses. Anything this cannot place runs in full.
 *
 * Outputs, one per CI job family:
 *   inspector  full | changed | docs | skip
 *              changed: only Inspector files moved, so Vitest runs the test
 *              files that import them (`--changed`). docs: only docs moved,
 *              so it runs the test files that mention `docs/`.
 *   rest       full | checks    the other workspaces' suites, or only the
 *                                repo guards when nothing else changed
 *   packaging  true | false      the SDK and @mcpjam/vitest tarball suite
 *   app        true | false      browser E2E and telemetry jobs
 *   code       true | false      false when every file is documentation
 *   build      true | false      lint.yml's typecheck and build
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const INSPECTOR = "mcpjam-inspector";
// Prose no test runs. A changeset is the release note a feature PR carries.
const DOC_DIRS = [".changeset/", "docs/", "internal-docs/", "notes/"];
// Docs files a build step checks: `npm run design:sync` writes this one.
const BUILD_CHECKED_DOCS = ["docs/style.css"];
// Inspector files that change how every test runs, not just what one tests.
const INSPECTOR_FULL_RUN = [
  /^mcpjam-inspector\/package\.json$/,
  /^mcpjam-inspector\/vitest[^/]*$/,
  /^mcpjam-inspector\/tsconfig[^/]*$/,
  /^mcpjam-inspector\/client\/src\/test\//,
  /^mcpjam-inspector\/server\/test\//,
];
// The packages the tarball suite packs.
const PACKAGING_ROOTS = ["sdk", "vitest"];

/** Every workspace each workspace depends on, directly or not. */
export function dependencyClosure(workspaces) {
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const memo = new Map();
  const visit = (dir, seen) => {
    if (memo.has(dir)) return memo.get(dir);
    const w = workspaces.find((x) => x.dir === dir);
    const out = new Set();
    for (const dep of w.deps) {
      const target = byName.get(dep);
      if (!target || seen.has(target.dir)) continue;
      out.add(target.dir);
      for (const d of visit(target.dir, new Set([...seen, target.dir]))) out.add(d);
    }
    memo.set(dir, out);
    return out;
  };
  return new Map(workspaces.map((w) => [w.dir, visit(w.dir, new Set([w.dir]))]));
}

const FULL = {
  inspector: "full",
  rest: "full",
  packaging: true,
  app: true,
  code: true,
  build: true,
};

/**
 * @param {object} input
 * @param {boolean} input.isPullRequest  false for Release and manual runs
 * @param {string[]} input.files          paths the PR changes
 * @param {{dir: string, name: string, deps: string[]}[]} input.workspaces
 */
export function ciScope({ isPullRequest, files, workspaces }) {
  if (!isPullRequest || files.length === 0) return { ...FULL };

  const dirs = new Set(workspaces.map((w) => w.dir));
  const closure = dependencyClosure(workspaces);
  const changed = new Set();
  let docs = false;
  let buildCheckedDocs = false;
  for (const file of files) {
    if (DOC_DIRS.some((d) => file.startsWith(d))) {
      docs = true;
      if (BUILD_CHECKED_DOCS.includes(file)) buildCheckedDocs = true;
      continue;
    }
    const top = file.split("/")[0];
    // Root files, .github, scripts and any directory that is not a workspace
    // can affect anything.
    if (!file.includes("/") || !dirs.has(top)) return { ...FULL };
    if (top === INSPECTOR && INSPECTOR_FULL_RUN.some((re) => re.test(file)))
      return { ...FULL };
    changed.add(top);
  }

  if (changed.size === 0) {
    // Documentation only. Tests read some docs files (the OpenAPI spec, the
    // docs nav), so the suites that can read them still run.
    return {
      inspector: "docs",
      rest: "full",
      packaging: false,
      app: false,
      code: false,
      build: buildCheckedDocs,
    };
  }

  const affects = (dir) =>
    changed.has(dir) || [...changed].some((c) => closure.get(dir).has(c));
  const inspectorDepsChanged = [...changed].some((c) =>
    closure.get(INSPECTOR).has(c)
  );
  const inspector = inspectorDepsChanged
    ? "full"
    : changed.has(INSPECTOR)
      ? "changed"
      : docs
        ? "docs"
        : "skip";
  const rest = [...dirs].some((d) => d !== INSPECTOR && affects(d))
    ? "full"
    : "checks";
  return {
    inspector,
    rest,
    packaging: PACKAGING_ROOTS.some(affects),
    app: inspector === "full" || inspector === "changed",
    code: true,
    build: true,
  };
}

function readWorkspaces(root) {
  const { workspaces } = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  return workspaces.map((dir) => {
    const pkg = JSON.parse(readFileSync(`${root}/${dir}/package.json`, "utf8"));
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    });
    return { dir, name: pkg.name, deps };
  });
}

// CLI: writes `key=value` lines to $GITHUB_OUTPUT (or stdout). A pull
// request's checkout is the merge commit, whose first parent is the base, so
// `HEAD^1..HEAD` is exactly the PR's change. Any error exits non-zero, and the
// jobs treat a failed scope as "run everything".
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const isPullRequest = process.env.GITHUB_EVENT_NAME === "pull_request";
  const files = isPullRequest
    ? execFileSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], {
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean)
    : [];
  const scope = ciScope({ isPullRequest, files, workspaces: readWorkspaces(".") });
  const lines = Object.entries(scope).map(([k, v]) => `${k}=${v}`);
  console.log(`${files.length} changed files\n${lines.join("\n")}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
