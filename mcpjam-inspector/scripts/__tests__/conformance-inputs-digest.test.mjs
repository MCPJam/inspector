import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeConformanceInputsDigest,
  globToRegExp,
  isConformanceInput,
} from "../conformance-inputs-digest.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const inspector = join(repoRoot, "mcpjam-inspector");

// What a conformance leg loads: the scenarios and the scripts its steps run.
const CONFORMANCE_DIR = join(inspector, "server/utils/harness/local/conformance");
const LEG_SCRIPTS = [
  "prepare-published-harness-conformance.mjs",
  "write-conformance-evidence.mjs",
  "read-local-harness-toolchain.mjs",
  "build-local-harness-pack.mjs",
  "check-local-harness-inputs.mjs",
  "inspector-layer-digests.mjs",
];
const WORKSPACES = { sdk: "sdk", evaluators: "evaluators", "widget-react": "widget-react", "design-system": "design-system", "chat-ui": "chat-ui", "surface-core": "surface-core", cli: "cli", vitest: "vitest" };
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs", ".json", "/index.ts", "/index.mts", "/index.js", "/index.mjs"];
const SPECIFIER = /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']|new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g;

function resolveFile(base) {
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  // TypeScript sources import their siblings as `.js`.
  const typescript = base.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts");
  return typescript !== base && existsSync(typescript) ? typescript : null;
}

function resolveSpecifier(from, specifier) {
  if (specifier.startsWith(".")) return resolveFile(resolve(dirname(from), specifier));
  if (specifier.startsWith("@/shared/")) return resolveFile(join(inspector, "shared", specifier.slice("@/shared/".length)));
  if (specifier.startsWith("@/")) return resolveFile(join(inspector, "src", specifier.slice(2)));
  const workspace = specifier.match(/^@mcpjam\/([^/]+)(?:\/(.*))?$/);
  if (workspace && WORKSPACES[workspace[1]]) {
    const subpath = (workspace[2] ?? "index").replace(/^internal\//, "");
    return resolveFile(join(repoRoot, WORKSPACES[workspace[1]], "src", subpath));
  }
  return null;
}

/** Every repo file reachable from the entry points through literal imports. */
function importGraph(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx|mts|mjs|js|cjs)$/.test(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const target = resolveSpecifier(file, match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]);
      if (target !== null) queue.push(target);
    }
  }
  return [...seen].map((file) => relative(repoRoot, file).split("\\").join("/"));
}

test("no file a conformance leg loads is excluded from the digest", () => {
  const entries = [
    ...readdirSync(CONFORMANCE_DIR).filter((name) => /\.(ts|mts|mjs)$/.test(name)).map((name) => join(CONFORMANCE_DIR, name)),
    ...LEG_SCRIPTS.map((name) => join(inspector, "scripts", name)),
  ];
  const reached = importGraph(entries);
  // A walker that found almost nothing would pass this vacuously.
  assert.ok(reached.length > 300, `only ${reached.length} files reached`);
  assert.deepEqual(reached.filter((path) => !isConformanceInput(path)).sort(), []);
});

test("globs match within a segment, across segments, and from the root only when anchored there", () => {
  assert.ok(globToRegExp("*.md").test("README.md"));
  assert.ok(!globToRegExp("*.md").test("sdk/skills/SKILL.md"));
  assert.ok(globToRegExp("**/CHANGELOG.md").test("CHANGELOG.md"));
  assert.ok(globToRegExp("**/CHANGELOG.md").test("sdk/CHANGELOG.md"));
  assert.ok(globToRegExp("**/__tests__/**").test("a/b/__tests__/c/d.ts"));
  assert.ok(!globToRegExp("mcpjam-inspector/vite.*").test("mcpjam-inspector/vitest.config.ts"));
  assert.equal(isConformanceInput(".github/workflows/local-harness-conformance.yml"), true);
  assert.equal(isConformanceInput(".github/workflows/release.yml"), false);
  assert.equal(isConformanceInput("sdk/skills/create-mcp-eval/SKILL.md"), true);
});

/** A throwaway repo shaped like this one, committed after every change. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "conformance-inputs-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" });
  const write = (path, value) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const lock = (sdk, inspectorVersion, zod) => ({
    name: "root",
    lockfileVersion: 3,
    packages: {
      "": { name: "root", workspaces: ["sdk", "mcpjam-inspector"] },
      sdk: { name: "@mcpjam/sdk", version: sdk },
      "mcpjam-inspector": { name: "@mcpjam/inspector", version: inspectorVersion, dependencies: { "@mcpjam/sdk": `^${sdk}`, zod: "^3.0.0" } },
      "node_modules/@mcpjam/sdk": { resolved: "sdk", link: true },
      "node_modules/@mcpjam/inspector": { resolved: "mcpjam-inspector", link: true },
      "node_modules/zod": { version: zod, resolved: `https://registry.npmjs.org/zod/-/zod-${zod}.tgz`, integrity: `sha512-${zod}` },
    },
  });
  const release = (sdk, inspectorVersion, zod = "3.0.0") => {
    write("package.json", { name: "root", private: true, workspaces: ["sdk", "mcpjam-inspector"] });
    write("sdk/package.json", { name: "@mcpjam/sdk", version: sdk });
    write("mcpjam-inspector/package.json", { name: "@mcpjam/inspector", version: inspectorVersion, dependencies: { "@mcpjam/sdk": `^${sdk}`, zod: "^3.0.0" } });
    write("package-lock.json", lock(sdk, inspectorVersion, zod));
  };
  return {
    dir,
    release,
    write,
    commit: () => {
      git("add", "-A");
      git("commit", "-q", "-m", "change", "--allow-empty");
      return computeConformanceInputsDigest({ cwd: dir });
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a version bump leaves the digest alone; a dependency or a server change moves it", () => {
  const repo = fixture();
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo.dir });
    repo.release("1.0.0", "3.0.0");
    repo.write("mcpjam-inspector/server/supervisor.ts", "export const a = 1;\n");
    repo.write("mcpjam-inspector/client/App.tsx", "export const b = 1;\n");
    const base = repo.commit();

    repo.release("1.1.0", "3.1.0");
    repo.write("sdk/CHANGELOG.md", "## 1.1.0\n");
    repo.write(".changeset/next.md", "---\n---\n");
    assert.equal(repo.commit(), base, "versions, changelogs and changesets are not inputs");

    repo.write("mcpjam-inspector/client/App.tsx", "export const b = 2;\n");
    assert.equal(repo.commit(), base, "the browser UI is not an input");

    repo.release("1.1.0", "3.1.0", "3.0.1");
    const bumped = repo.commit();
    assert.notEqual(bumped, base, "a third-party dependency is an input");

    repo.write("mcpjam-inspector/server/supervisor.ts", "export const a = 2;\n");
    assert.notEqual(repo.commit(), bumped, "the server is an input");
  } finally {
    repo.cleanup();
  }
});
