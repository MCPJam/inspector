import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

// Paths are relative to the repo root, with "/" separators on every platform.
const ROOTS = ["sdk/src", "mcpjam-inspector"];
// Build output and tool state that .gitignore keeps out of `git ls-files`.
const SKIPPED_DIRS = new Set(["node_modules", "dist", "out", "build", "coverage", "test-results", "playwright-report"]);

export const isCatalogSource = (file) =>
  /\.[cm]?tsx?$/.test(file) && !/(?:__tests__|\.test\.|\.generated\.|\.bundled\.|\/tests\/)/.test(file);

export function gitSourceFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...ROOTS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .split("\n")
    .filter((file) => isCatalogSource(file) && existsSync(file));
}

// Docker and Railway build from a copy of the tree with no .git directory.
export function walkedSourceFiles() {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory())
        return entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name) ? [] : walk(`${dir}/${entry.name}`);
      return [`${dir}/${entry.name}`];
    });
  return ROOTS.flatMap(walk).filter(isCatalogSource);
}

export function catalogSourceFiles() {
  try {
    return gitSourceFiles();
  } catch {
    return walkedSourceFiles();
  }
}
