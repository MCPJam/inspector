// One digest for everything a local harness conformance leg could load.
//
//   node scripts/conformance-inputs-digest.mjs        # prints sha256:…
//
// Conformance evidence records it (write-conformance-evidence.mjs), and the
// release gate accepts evidence from an earlier commit only when that
// commit's digest equals this one's (check-local-harness-release.mjs). That
// is what lets a release reuse the evidence a run on `main` already produced,
// instead of running every platform again for a commit that changed nothing
// a leg can load.
//
// Conservative by construction: every tracked file counts unless it matches
// NOT_CONFORMANCE_INPUTS, which lists things no leg loads: the browser UI,
// the desktop shell, docs, changelogs, tests, other workspaces and other
// workflows. `conformance-inputs-digest.test.mjs` walks the scenarios' import
// graph and fails if a file it reaches is on that list.
//
// Two kinds of change are normalized away, because the version PR makes both
// on every release: a workspace package's own `version` and its siblings'
// ranges on it, and the matching workspace entries of package-lock.json.
// Third-party dependencies still count, through the lockfile's resolved tree.
//
// Read from git objects, not the working tree, so a build, a CRLF checkout
// on Windows or an untracked file cannot move it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Repo-relative globs (`*` within a segment, `**` across) no leg can load. */
export const NOT_CONFORMANCE_INPUTS = Object.freeze([
  // Tooling, notes and every workflow but the conformance one (see below).
  ".agents/**",
  ".changeset/**",
  ".claude/**",
  ".devin/**",
  ".github/**",
  ".mcpjam/**",
  ".release-plan/**",
  ".spike-codex-appserver/**",
  "*.md",
  "LICENSE",
  "railway.json",
  // Workspaces and folders the scenarios never import.
  "actions/**",
  "chat-ui/**",
  "cli/**",
  "design-explorations/**",
  "design-system/**",
  "discord-app/**",
  "docs/**",
  "examples/**",
  "mcp/**",
  "notes/**",
  "ops/**",
  "preview-router/**",
  "skills/**",
  "slack-app/**",
  "soundcheck/**",
  "surface-core/**",
  "vitest/**",
  "widget-react/**",
  // The Inspector's browser UI, desktop shell, hosted image and docs.
  "mcpjam-inspector/client/**",
  "mcpjam-inspector/src/**",
  "mcpjam-inspector/e2e/**",
  "mcpjam-inspector/docs/**",
  "mcpjam-inspector/assets/**",
  "mcpjam-inspector/*.md",
  "mcpjam-inspector/*.mdx",
  "mcpjam-inspector/playwright*.config.ts",
  "mcpjam-inspector/vite.*",
  "mcpjam-inspector/forge.config.ts",
  "mcpjam-inspector/Dockerfile",
  "mcpjam-inspector/.dockerignore",
  "mcpjam-inspector/.railwayignore",
  "mcpjam-inspector/compose.yaml",
  "mcpjam-inspector/eslint.config.js",
  "mcpjam-inspector/.prettierrc",
  "mcpjam-inspector/.prettierignore",
  "mcpjam-inspector/harness-bake.lock.json",
  // Tests and changelogs, wherever they live.
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/CHANGELOG.md",
  "sdk/tests/**",
  "sdk/README.md",
  "evaluators/tests/**",
  "evaluators/bench/**",
  "evaluators/README.md",
]);

/** Inputs even though a pattern above would exclude them. */
export const CONFORMANCE_INPUT_EXCEPTIONS = Object.freeze([
  ".github/workflows/local-harness-conformance.yml",
]);

export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char !== "*") {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    } else if (glob[i + 1] !== "*") {
      source += "[^/]*";
    } else if (glob[i + 2] === "/") {
      source += "(?:.*/)?";
      i += 2;
    } else {
      source += ".*";
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

const EXCLUDED = NOT_CONFORMANCE_INPUTS.map(globToRegExp);

/** Whether a repo-relative path can change what a conformance leg runs. */
export function isConformanceInput(path) {
  if (CONFORMANCE_INPUT_EXCEPTIONS.includes(path)) return true;
  return !EXCLUDED.some((pattern) => pattern.test(path));
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** A package.json without what a version bump changes. */
export function normalizePackageJson(text, workspaceNames) {
  const manifest = JSON.parse(text);
  delete manifest.version;
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (workspaceNames.has(name)) delete manifest[field][name];
    }
  }
  return JSON.stringify(manifest);
}

/**
 * The lockfile's resolved third-party tree. Workspace entries carry the
 * versions a release bumps, and their links point back at sources the digest
 * already covers file by file.
 */
export function normalizePackageLock(text) {
  const lock = JSON.parse(text);
  const packages = {};
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.includes("node_modules/") || entry?.link === true) continue;
    packages[key] = entry;
  }
  return JSON.stringify({ lockfileVersion: lock.lockfileVersion, packages });
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** `sha256:…` over every conformance input at `rev`. */
export function computeConformanceInputsDigest({ cwd = REPO_ROOT, rev = "HEAD" } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  const entries = git("ls-tree", "-r", "-z", "--full-tree", rev)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, object] = line.slice(0, tab).split(" ");
      return { mode, type, object, path: line.slice(tab + 1) };
    });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const blob = (path) => git("cat-file", "blob", byPath.get(path).object).toString("utf8");

  const workspaces = byPath.has("package.json") ? JSON.parse(blob("package.json")).workspaces ?? [] : [];
  const workspacePatterns = workspaces.map((glob) => globToRegExp(`${glob}/package.json`));
  const workspaceNames = new Set(
    entries
      .filter((entry) => workspacePatterns.some((pattern) => pattern.test(entry.path)))
      .map((entry) => JSON.parse(blob(entry.path)).name)
      .filter((name) => typeof name === "string"),
  );

  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (!isConformanceInput(entry.path)) continue;
    let content = `${entry.type}:${entry.object}`;
    if (entry.path === "package-lock.json") {
      content = `lock:${sha256(normalizePackageLock(blob(entry.path)))}`;
    } else if (entry.type === "blob" && (entry.path === "package.json" || entry.path.endsWith("/package.json"))) {
      content = `manifest:${sha256(normalizePackageJson(blob(entry.path), workspaceNames))}`;
    }
    hash.update(`${entry.mode} ${entry.path} ${content}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(`${computeConformanceInputsDigest()}\n`);
}
