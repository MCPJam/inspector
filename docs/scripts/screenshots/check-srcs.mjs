#!/usr/bin/env node
// Cross-checks docs images: every /images/... src used in an .mdx file must
// resolve to a real file, and every manifest PNG that exists on disk must be
// referenced from its own page. Run: node docs/scripts/screenshots/check-srcs.mjs

import { readFileSync, existsSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(DOCS_ROOT, "..");
const manifest = JSON.parse(readFileSync(path.join(__dirname, "manifest.json"), "utf8"));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".mdx")) out.push(full);
  }
  return out;
}

let failures = 0;
const mdxFiles = walk(DOCS_ROOT);
const srcsByFile = new Map();

for (const file of mdxFiles) {
  const text = readFileSync(file, "utf8");
  const srcs = [...text.matchAll(/src="(\/images\/[^"]+)"/g)].map((m) => m[1]);
  srcsByFile.set(path.relative(DOCS_ROOT, file).split(path.sep).join("/"), srcs);
  for (const src of srcs) {
    const onDisk = path.join(DOCS_ROOT, src.replace(/^\//, ""));
    if (!existsSync(onDisk)) {
      console.error(`FAIL: ${file}: src "${src}" does not resolve to a file`);
      failures++;
    }
  }
}

for (const entry of manifest.entries) {
  const onDisk = path.join(REPO_ROOT, entry.output);
  if (!existsSync(onDisk)) {
    console.warn(`WARN: ${entry.id}: output ${entry.output} does not exist yet, skipping`);
    continue;
  }
  const src = "/" + path.relative(DOCS_ROOT, onDisk).split(path.sep).join("/");
  // Normalize to the same key format srcsByFile uses (relative, forward
  // slashes) -- capture.mjs --validate tolerates a leading slash or
  // backslashes in `page`, so tolerate them here too instead of emitting a
  // misleading "not referenced" failure.
  const pageKey = entry.page.replace(/\\/g, "/").replace(/^\/+/, "");
  const pageSrcs = srcsByFile.get(pageKey) ?? [];
  if (!pageSrcs.includes(src)) {
    console.error(`FAIL: ${entry.id}: ${src} not referenced from its page (${entry.page})`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`check-srcs FAILED (${failures} error(s))`);
  process.exitCode = 1;
} else {
  console.log(`check-srcs OK (${mdxFiles.length} mdx files, ${manifest.entries.length} manifest entries)`);
}
