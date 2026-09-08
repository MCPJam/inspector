#!/usr/bin/env node
/**
 * No new hand-built MCPJam app URLs.
 *
 * The bug this repository just spent a release fixing was a URL assembled from
 * an id: `https://app.mcpjam.com/servers`, `${origin}/evals/suite/${id}`. Each
 * one had to remember `?project=`, each had to remember to encode its
 * segments, and three separate copies of the eval-run URL had drifted apart by
 * the time anyone counted them. `buildAppPermalink` in
 * `sdk/src/platform/permalinks.ts` is now the one place that composes an app
 * URL from a resource, and this guard is what keeps it the one place.
 *
 * What it flags: a string that glues an app origin (or an origin variable) to
 * a known app route AND something after it — an id, a token, a nested route.
 * That is a link to a RESOURCE, which is what must go through the builder.
 *
 * What it does not flag, deliberately:
 *   - naming the origin, comparing against it, or documenting it;
 *   - a bare collection link (`${APP_ORIGIN}/servers`), which addresses no
 *     resource and needs no project scope — the marketing CTAs are this;
 *   - anything under `/shared/`, which is a token-bearing SHARE link. Those
 *     are backend-minted product capabilities with their own access rules,
 *     explicitly not permalinks, and the builder must never mint one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Route roots a permalink can address. Grown only with the route registry. */
const ROUTE_SEGMENTS = [
  "servers",
  "environments",
  "evals",
  "sessions",
  "conformance",
  "swarms",
  "user-testing",
  "hosts",
  "organizations",
];

const ORIGIN_EXPRESSION = String.raw`(?:https?://[a-z0-9.-]*mcpjam\.com|\$\{[A-Za-z_$][\w$.]*(?:ORIGIN|OrIGIN|Origin|origin|appUrl|APP_URL|baseUrl|BASE_URL|webOrigin)[\w$.]*\})`;
const PATTERN = new RegExp(
  `${ORIGIN_EXPRESSION}/(?:${ROUTE_SEGMENTS.join("|")})(?:/(?!shared\\b)|\\?)`,
);

/**
 * Files allowed to contain one.
 *
 * The builder itself, its tests, and the two places that MIRROR it by
 * documented design: `surface-core` vendors with zero dependencies, and the
 * SDK's CI reporter prints a deliberately unscoped fallback line for a backend
 * that does not echo a project id. Everything else asks the builder.
 */
const ALLOWLIST = [
  /^sdk\/src\/platform\/permalinks\.ts$/,
  /^sdk\/src\/platform\/__tests__\//,
  /^surface-core\/src\/api-client\.js$/,
  /^scripts\/check-permalink-concatenation\.mjs$/,
  /__tests__\//,
  /\.test\.[jt]sx?$/,
  /\/tests\//,
];

/**
 * Directories never worth scanning.
 *
 * A plain walk rather than `git ls-files`: the runner checks the repo out as a
 * different uid than the one the job runs as, so git refuses the worktree as
 * "dubious ownership" and the whole check dies before it reads a single file.
 * Walking the filesystem has no such failure mode, works in a container, and
 * catches an offending file before it is ever committed.
 */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".wrangler",
  "playwright-report",
  "test-results",
]);

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (
      entry.isFile() &&
      EXTENSIONS.some((extension) => entry.name.endsWith(extension)) &&
      // Generated bundles embed whatever their source embedded; the source is
      // what the guard is for.
      !entry.name.includes(".bundled.") &&
      !entry.name.includes(".generated.")
    ) {
      yield relative(process.cwd(), full).split(sep).join("/");
    }
  }
}

const files = [...walk(process.cwd())];

const findings = [];
for (const file of files) {
  if (ALLOWLIST.some((allowed) => allowed.test(file))) continue;
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  source.split("\n").forEach((line, index) => {
    // Comments describe URLs constantly; only CODE builds them.
    const trimmed = line.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
    if (PATTERN.test(line)) {
      findings.push(`${file}:${index + 1}: ${trimmed.slice(0, 160)}`);
    }
  });
}

if (findings.length > 0) {
  console.error(
    "Hand-built MCPJam app URLs found. Use `buildAppPermalink` from\n" +
      "`@mcpjam/sdk/platform` instead — it carries `?project=`, encodes its\n" +
      "segments, and merges with a route's existing query:\n"
  );
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}

console.log(`check:permalink-concatenation — clean (${files.length} files).`);
