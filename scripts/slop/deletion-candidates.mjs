#!/usr/bin/env node
/**
 * Candidates for the nightly deletion bot (`.github/workflows/slop-deletion-bot.yml`).
 * The bot hands this list to Claude, which verifies one candidate and deletes
 * it. Nothing here deletes anything.
 *
 *   dead-files:       source files whose name appears in no other tracked file.
 *                     A module nobody names cannot be imported, required, globbed
 *                     by name or listed in a manifest. Its own tests do not count
 *                     as a reference; they go with it.
 *   history-comments: files with the most comments citing PR numbers or dates.
 *
 *   node scripts/slop/deletion-candidates.mjs [--limit 20] [--exclude paths.txt]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { measure, packageOf } from "./measure.mjs";
import { isMeasuredFile } from "./rules.mjs";

/** Names that are entry points by convention, found by tools rather than imports. */
const ENTRY_STEM =
  /^(?:index|main|app|App|server|cli|worker|preload|setup|global-setup|env|vite-env|middleware|instrument)$/;
const ENTRY_PATH =
  /(?:^|\/)(?:bin|scripts|\.github|examples|docs|migrations|pages|routes\/_|api|test-servers)\/|\.config\.[^/]+$/;

/** Text files worth searching for a reference. Binaries and lockfiles are not. */
const SEARCHED = /\.(?:[cm]?[jt]sx?|json|jsonc|ya?ml|md|mdx|html|css|sh|toml)$/;
const NOT_SEARCHED = /(?:^|\/)package-lock\.json$|\.snap$/;

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

/**
 * Top-level packages whose `exports` map has a `*` pattern: any file under
 * them may be public API that no file in this repo names.
 */
function wildcardPackages() {
  const names = new Set();
  for (const dir of execFileSync("git", ["ls-files", "*/package.json"], {
    encoding: "utf8",
  }).split("\n")) {
    if (!dir || dir.split("/").length !== 2 || !existsSync(dir)) continue;
    const { exports } = JSON.parse(readFileSync(dir, "utf8"));
    if (JSON.stringify(exports ?? {}).includes("*"))
      names.add(dir.split("/")[0]);
  }
  return names;
}

const stemOf = (path) => basename(path).replace(/\.[^.]+$/, "");

/** Every `[\w-]+` token in the repo, mapped to the files it appears in. */
function tokenIndex(paths) {
  const index = new Map();
  for (const path of paths) {
    if (!SEARCHED.test(path) || NOT_SEARCHED.test(path)) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      // Tracked but missing from the working tree: nothing to index.
      continue;
    }
    for (const token of new Set(text.match(/[\w-]+/g) ?? [])) {
      let files = index.get(token);
      if (!files) index.set(token, (files = new Set()));
      files.add(path);
    }
  }
  return index;
}

/** A file's own tests reference it, but deleting the file deletes them too. */
function isOwnTest(path, stem) {
  const name = basename(path);
  return (
    name.startsWith(`${stem}.test.`) ||
    name.startsWith(`${stem}.spec.`) ||
    name.startsWith(`${stem}.stories.`)
  );
}

export function deadFiles(paths = trackedFiles()) {
  const index = tokenIndex(paths);
  const wildcard = wildcardPackages();
  const results = [];
  for (const path of paths) {
    if (!isMeasuredFile(path) || ENTRY_PATH.test(path)) continue;
    if (wildcard.has(path.split("/")[0])) continue;
    const stem = stemOf(path);
    // Dotted names (`foo.server`) tokenize into parts and cannot be checked this way.
    if (!/^[\w-]+$/.test(stem) || ENTRY_STEM.test(stem)) continue;
    const referrers = [...(index.get(stem) ?? [])].filter(
      (other) => other !== path
    );
    const tests = referrers.filter((other) => isOwnTest(other, stem));
    if (referrers.length !== tests.length) continue;
    const lines = readFileSync(path, "utf8").split("\n").length;
    const testLines = tests.reduce(
      (sum, test) => sum + readFileSync(test, "utf8").split("\n").length,
      0
    );
    results.push({
      path,
      package: packageOf(path),
      lines,
      tests,
      totalLines: lines + testLines,
    });
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export function historyComments(limit) {
  const { files } = measure();
  return Object.entries(files)
    .map(([path, counts]) => ({
      path,
      package: packageOf(path),
      count: counts["history-comment"],
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const limit = Number(argValue("--limit") ?? 20);
  // Paths an open or rejected bot PR already touched, one per line.
  const excludeFile = argValue("--exclude");
  const excluded = new Set(
    excludeFile
      ? readFileSync(excludeFile, "utf8").split("\n").filter(Boolean)
      : []
  );
  const keep = (entry) => !excluded.has(entry.path);
  console.log(
    JSON.stringify(
      {
        deadFiles: deadFiles().filter(keep),
        historyComments: historyComments(limit + excluded.size)
          .filter(keep)
          .slice(0, limit),
      },
      null,
      2
    )
  );
}
