#!/usr/bin/env node
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const targetRoots = [
  "sdk/src",
  "mcpjam-inspector/bin",
  "mcpjam-inspector/server",
  "mcpjam-inspector/lib",
  "cli/src",
];

const skippedDirectoryNames = new Set([
  ".git",
  "dist",
  "node_modules",
  "out",
  "__tests__",
]);

const scannedExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const skippedFileSuffixes = [
  ".bundled.ts",
  ".bundled.tsx",
  ".d.ts",
  ".generated.ts",
  ".generated.tsx",
  ".test.ts",
  ".test.tsx",
];

// Literal-only by design: this catches the published crash class without
// banning normal source-relative imports.
const checks = [
  {
    label: "relative package.json require",
    pattern: /\brequire\s*\(\s*(["'])\.\.\/[^"'`]*package\.json\1\s*\)/g,
  },
  {
    label: "relative package.json require.resolve",
    pattern:
      /\brequire\.resolve\s*\(\s*(["'])\.\.\/[^"'`]*package\.json\1\s*\)/g,
  },
  {
    label: "relative package.json dynamic import",
    pattern: /\bimport\s*\(\s*(["'])\.\.\/[^"'`]*package\.json\1\s*\)/g,
  },
  {
    label: "relative URL from import.meta.url",
    pattern:
      /\bnew\s+URL\s*\(\s*(["'])\.\.\/[^"'`]*\1\s*,\s*import\.meta\.url\s*\)/g,
  },
  {
    label: "relative path.join from __dirname",
    pattern:
      /\bpath\.join\s*\(\s*__dirname\s*,\s*(["'])\.\.\/[^"'`]*\1/g,
  },
  {
    label: "relative path.resolve from __dirname",
    pattern:
      /\bpath\.resolve\s*\(\s*__dirname\s*,\s*(["'])\.\.\/[^"'`]*\1/g,
  },
];

function shouldScanFile(filePath) {
  const ext = path.extname(filePath);
  const basename = path.basename(filePath);
  return (
    scannedExtensions.has(ext) &&
    !skippedFileSuffixes.some((suffix) => basename.endsWith(suffix))
  );
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (!skippedDirectoryNames.has(entry)) {
        yield* walk(fullPath);
      }
      continue;
    }

    if (stat.isSymbolicLink()) {
      continue;
    }

    if (stat.isFile() && shouldScanFile(fullPath)) {
      yield fullPath;
    }
  }
}

function lineAndColumnForOffset(source, offset) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

const violations = [];

for (const root of targetRoots) {
  const absoluteRoot = path.join(repoRoot, root);
  for (const filePath of walk(absoluteRoot)) {
    const source = readFileSync(filePath, "utf8");
    for (const check of checks) {
      check.pattern.lastIndex = 0;
      for (const match of source.matchAll(check.pattern)) {
        const position = lineAndColumnForOffset(source, match.index ?? 0);
        violations.push({
          filePath,
          check: check.label,
          snippet: match[0],
          ...position,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Bundled runtime path check failed.");
  console.error(
    "Use package self-references or package-manager resolution instead of source-layout-relative runtime paths.",
  );
  for (const violation of violations) {
    const relativePath = path.relative(repoRoot, violation.filePath);
    console.error(
      `\n${relativePath}:${violation.line}:${violation.column} ${violation.check}`,
    );
    console.error(`  ${violation.snippet}`);
  }
  process.exit(1);
}

console.log("Bundled runtime path check passed.");
