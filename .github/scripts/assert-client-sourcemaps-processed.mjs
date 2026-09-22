#!/usr/bin/env node
/**
 * Fail the release if the client build's source maps were not processed.
 *
 * `sentryVitePlugin` treats a sourcemap glob that matches nothing as a
 * warning — `Didn't find any matching sources for debug ID upload` — and
 * carries on with a green build. That is how 2.47.0 shipped: the plugin
 * uploaded no maps, deleted none either, and the tarball went to npm with
 * `assets/index-<hash>.js.map` still beside the bundle. Every client event in
 * that release then symbolicated against another build's artifacts, naming
 * files that had nothing to do with the crash, and nothing anywhere said so.
 *
 * Two things are checked, both local and both cheap:
 *
 *  1. The assets directory exists and emitted at least one JS chunk. A build
 *     that produced nothing cannot have uploaded anything.
 *  2. No `.map` survives under the dist. The plugin deletes them once it has
 *     taken them (`sourcemaps.filesToDeleteAfterUpload`), so a leftover map is
 *     proof the sourcemap pipeline never saw the build output.
 *
 * What this deliberately does NOT claim: that Sentry accepted the upload. That
 * needs a Sentry-side query, and the acceptance criterion for it is a real
 * post-deploy event whose frames name client files.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const distDir = process.argv[2] ?? "mcpjam-inspector/dist/client";
const assetsDir = join(distDir, "assets");

/** Every file under `dir`, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const problems = [];

if (!existsSync(assetsDir)) {
  problems.push(`${assetsDir} does not exist — the client build produced no assets.`);
} else {
  const files = walk(assetsDir);
  const chunks = files.filter((f) => f.endsWith(".js"));
  if (chunks.length === 0) {
    problems.push(`${assetsDir} contains no .js chunk.`);
  }

  const maps = walk(distDir).filter((f) => f.endsWith(".map"));
  if (maps.length > 0) {
    problems.push(
      `${maps.length} source map(s) survived the build, so the Sentry plugin ` +
        `never processed this output:\n` +
        maps.map((m) => `    ${relative(distDir, m)}`).join("\n"),
    );
  }

  if (problems.length === 0) {
    console.log(
      `[assert-client-sourcemaps] ok — ${chunks.length} chunk(s) in ${assetsDir}, no maps left behind.`,
    );
  }
}

if (problems.length > 0) {
  console.error("[assert-client-sourcemaps] FAILED");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\n  Check that `sourcemaps.assets` in client/vite.config.ts still resolves\n" +
      "  to the real output directory. The plugin globs against process.cwd(),\n" +
      "  not the Vite root, so a relative pattern there silently matches nothing.",
  );
  process.exit(1);
}
