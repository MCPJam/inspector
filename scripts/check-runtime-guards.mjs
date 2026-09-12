#!/usr/bin/env node
/**
 * The repo's forbidden-symbol guards, as a program instead of a shell negation.
 *
 * They used to be `! rg …` in `package.json`. That construction FAILS OPEN, and
 * not in a subtle way: if ripgrep is not on PATH the shell exits 127, `!`
 * inverts that to 0, and the guard reports success having inspected nothing.
 * The same happens when a scan root is renamed or deleted — rg exits 2, `!`
 * makes it a pass. So the two properties a guard needs, "I ran" and "I found
 * nothing", were indistinguishable from each other, and three of the five steps
 * in `test:checks` could report green on a machine that had never looked at a
 * single file. That is how a check that has caught real regressions becomes
 * decoration.
 *
 * Rewritten in node for the same reason `check-bundled-runtime-paths.mjs` is:
 * no external binary to be absent, no shell semantics to invert, and the output
 * names the file and line rather than leaving the reader to re-run rg by hand.
 * Same walker shape and same skip conventions as that file — the two are peers
 * and should read like it.
 *
 * Three things are FAILURES here that a scanner usually treats as skips, and
 * they are the whole point: a missing scan root, a scan that reads zero files,
 * and a path the process could not read (see `scanErrors`). Each one is a way of
 * inspecting nothing while reporting success, which is the bug being fixed
 * rather than a lesser version of it.
 *
 * Usage: `node scripts/check-runtime-guards.mjs <check-name>`
 */
import { lstatSync, readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Directories no check ever descends into. `dist` is NOT here: the
 * `platform-runtime-safety:dist` check exists precisely to scan built output,
 * so it is excluded per-check instead (see `skipDirectoryNames` below).
 */
const alwaysSkippedDirectoryNames = new Set([
  ".git",
  "node_modules",
  "out",
  ".turbo",
  ".next",
]);

/**
 * Extensions worth reading. Broader than a source-file list on purpose: the rg
 * guards these replace had no type filter, so anything narrower would be a
 * silent weakening of a check nobody asked to weaken.
 */
const scannedExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const checks = {
  /**
   * The raw MCP SDK must not reach a runtime path. Runtime code talks to MCP
   * through `@mcpjam/sdk`; a direct dependency here is what the v1 migration
   * was for.
   */
  "mcp-v1-runtime-imports": {
    roots: [
      "sdk/src",
      "cli/src",
      "mcpjam-inspector/client/src",
      "mcpjam-inspector/server",
      "mcp/src",
    ],
    // Mirrors the rg globs the shell version carried.
    skipDirectoryNames: ["dist"],
    skipPathPrefixes: ["mcp/src/ui"],
    skipFileSuffixes: [".bundled.ts", ".generated.ts"],
    patterns: [
      {
        label: "raw @modelcontextprotocol/sdk import in runtime code",
        pattern: /@modelcontextprotocol\/sdk/g,
      },
    ],
  },

  /**
   * `sdk/src/platform` runs in a browser and in a Cloudflare Worker. A `node:`
   * builtin or a `process.env` read there is a crash on both.
   */
  "platform-runtime-safety": {
    roots: ["sdk/src/platform"],
    skipDirectoryNames: ["dist"],
    patterns: [
      { label: "node: builtin specifier", pattern: /["']node:/g },
      { label: "process.env read", pattern: /process\.env/g },
    ],
  },

  /**
   * The same assertion against the BUILT output, because a bundler can
   * reintroduce either one. Runs after `build -w @mcpjam/sdk`, so an absent
   * root means the build did not happen — which the shell version asserted with
   * `test -d` and is preserved by the missing-root error below.
   */
  "platform-runtime-safety-dist": {
    roots: ["sdk/dist/platform"],
    skipFileSuffixes: [".map"],
    patterns: [
      { label: "node: builtin specifier", pattern: /["']node:/g },
      { label: "process.env read", pattern: /process\.env/g },
    ],
  },
};

function lineForOffset(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Paths the scan could not read, which are FAILURES rather than skips.
 *
 * A guard that cannot read a subtree has not cleared it, and swallowing the
 * error is the same fail-open bug in a different costume: with one unreadable
 * directory and one readable file elsewhere, `scannedFiles > 0` and the run
 * reports "clean" for a tree it never opened. An unreadable path is exactly
 * where a violation would be least likely to be noticed.
 *
 * Collected rather than thrown on the spot so one run reports EVERY unreadable
 * path, the same way it reports every violation — someone fixing permissions
 * wants the whole list, not the first entry and another run.
 */
const scanErrors = [];

function* walk(dir, check) {
  const skipDirs = new Set([
    ...alwaysSkippedDirectoryNames,
    ...(check.skipDirectoryNames ?? []),
  ]);

  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    scanErrors.push({ path: dir, reason: `readdir failed: ${error.message}` });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch (error) {
      scanErrors.push({
        path: fullPath,
        reason: `lstat failed: ${error.message}`,
      });
      continue;
    }

    if (stat.isSymbolicLink()) continue;

    if (stat.isDirectory()) {
      if (!skipDirs.has(entry)) yield* walk(fullPath, check);
      continue;
    }

    if (!stat.isFile()) continue;

    const relative = path.relative(repoRoot, fullPath).split(path.sep).join("/");
    if ((check.skipPathPrefixes ?? []).some((p) => relative.startsWith(p))) {
      continue;
    }
    const basename = path.basename(fullPath);
    if ((check.skipFileSuffixes ?? []).some((s) => basename.endsWith(s))) {
      continue;
    }
    // `.map` is excluded by suffix above where a check asks for it; the
    // extension filter is what keeps the walk off binaries and lockfiles.
    if (!scannedExtensions.has(path.extname(fullPath))) continue;

    yield { fullPath, relative };
  }
}

const name = process.argv[2];
const check = checks[name];
if (!check) {
  console.error(
    `check-runtime-guards: unknown check "${name ?? ""}". ` +
      `Known checks: ${Object.keys(checks).join(", ")}`,
  );
  process.exit(1);
}

// A missing root is a FAILURE, never a pass. This is the fail-open case the rg
// version had: a renamed directory made the guard vacuous and silent.
for (const root of check.roots) {
  const absolute = path.join(repoRoot, root);
  if (!existsSync(absolute)) {
    console.error(
      `check-runtime-guards [${name}]: scan root "${root}" does not exist. ` +
        `Either the path moved (update this script) or a prerequisite build ` +
        `did not run. Refusing to report success without scanning it.`,
    );
    process.exit(1);
  }
}

const violations = [];
let scannedFiles = 0;

for (const root of check.roots) {
  for (const { fullPath, relative } of walk(
    path.join(repoRoot, root),
    check,
  )) {
    let source;
    try {
      source = readFileSync(fullPath, "utf8");
    } catch (error) {
      // Not a skip. An unread file is an uninspected file, and this guard's
      // only claim is that it inspected everything it was pointed at.
      scanErrors.push({
        path: relative,
        reason: `read failed: ${error.message}`,
      });
      continue;
    }
    scannedFiles += 1;
    for (const { label, pattern } of check.patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        violations.push({
          file: relative,
          line: lineForOffset(source, match.index),
          label,
          text: match[0],
        });
      }
    }
  }
}

// Zero files scanned means the globs stopped matching anything, which is the
// other shape of a vacuous pass.
if (scannedFiles === 0) {
  console.error(
    `check-runtime-guards [${name}]: scanned 0 files across ` +
      `${check.roots.join(", ")}. A guard that inspects nothing must not ` +
      `report success.`,
  );
  process.exit(1);
}

// Reported before violations and fatal on its own: "I could not read part of
// this tree" is a different and worse answer than "I read it and found
// nothing", and collapsing the two is the fail-open behaviour this script
// exists to remove.
if (scanErrors.length > 0) {
  console.error(
    `check-runtime-guards [${name}]: ${scanErrors.length} path(s) could not ` +
      `be scanned. Refusing to report success on a tree this run did not read.`,
  );
  for (const failure of scanErrors) {
    console.error(`  ${failure.path}  ${failure.reason}`);
  }
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`check-runtime-guards [${name}]: ${violations.length} found`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.label} — ${v.text}`);
  }
  process.exit(1);
}

console.log(
  `check-runtime-guards [${name}]: clean (${scannedFiles} files scanned)`,
);
