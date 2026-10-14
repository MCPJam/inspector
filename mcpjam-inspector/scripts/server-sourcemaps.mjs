#!/usr/bin/env node
/**
 * Sentry debug IDs and source maps for the standalone server. `build:server`
 * runs this after tsup, so the npm tarball and the Railway and Docker Hub
 * images ship the bytes it injected and verified, and with SENTRY_AUTH_TOKEN it
 * uploads those same files. A failed upload is reported but does not fail the
 * build, since a Sentry outage must not block a release; it does fail telemetry
 * acceptance (docs/server-error-reporting.md). Electron main maps its own
 * bundle in forge.config.ts.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TraceMap, decodedMappings } from "@jridgewell/trace-mapping";
import { sentryInjectedDebugId } from "@mcpjam/sdk/internal/telemetry";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** server/tsup.config.ts emits one file per entry and nothing else. */
const OUTPUTS = ["index.js", "harness-install-cli.js"];
const FIRST_PARTY = /^(?:\.\.\/)+(?:server|shared)\/.+\.ts$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*/;
// esbuild rewrites module syntax and declarations (`export const` -> `var`).
const LOWERED = /^(?:export|import|const|let|undefined)$/;

function sentryCli(args) {
  const pkg = createRequire(import.meta.url).resolve(
    "@sentry/cli/package.json",
  );
  // Through node: Windows cannot spawn the `.cmd` shim without a shell.
  execFileSync(
    process.execPath,
    [join(dirname(pkg), "bin/sentry-cli"), ...args],
    {
      stdio: "inherit",
      timeout: 5 * 60_000,
    },
  );
}

/**
 * The injected ID, which the runtime sends as `debug_meta`, must name the
 * output's map, every source must be relative, and first-party mappings must
 * land on the same identifier in the output and the source. esbuild's renamed
 * locals (`id2`) keep that short of all of them; a map from another build,
 * shifted by one line, falls far below the threshold.
 */
export function verifyServerSourcemaps(dir) {
  const unowned = readdirSync(dir).filter(
    (name) => !OUTPUTS.some((file) => name === file || name === `${file}.map`),
  );
  if (unowned.length)
    throw new Error(`unowned outputs in ${dir}: ${unowned.join(", ")}`);
  return OUTPUTS.map((file) => {
    const code = readFileSync(join(dir, file), "utf8");
    const map = JSON.parse(readFileSync(join(dir, `${file}.map`), "utf8"));
    const debugId = sentryInjectedDebugId(code);
    const mapId = map.debugId ?? map.debug_id;
    if (!debugId || debugId !== mapId)
      throw new Error(
        `${file}: injected debug ID ${debugId} does not match its map's ${mapId}`,
      );
    const local = map.sources.find((source) =>
      /^(?:[/\\]|[a-z][\w+.-]*:)/i.test(source),
    );
    if (local)
      throw new Error(`${file}.map names a build machine path: ${local}`);
    const lines = code.split("\n");
    const sources = map.sourcesContent.map((text) => text?.split("\n"));
    let [checked, matched] = [0, 0];
    decodedMappings(new TraceMap(map)).forEach((segments, line) => {
      for (const [column, source, sourceLine, sourceColumn] of segments) {
        if (
          sourceColumn === undefined ||
          !FIRST_PARTY.test(map.sources[source])
        )
          continue;
        const emitted = IDENTIFIER.exec(lines[line]?.slice(column) ?? "")?.[0];
        const text = sources[source]?.[sourceLine]?.slice(sourceColumn);
        const original = IDENTIFIER.exec(text ?? "")?.[0];
        if (!emitted || (original && LOWERED.test(original))) continue;
        checked += 1;
        if (emitted === original || emitted.replace(/\d+$/, "") === original)
          matched += 1;
      }
    });
    if (checked < 10 || matched / checked < 0.9)
      throw new Error(
        `${file}: ${matched} of ${checked} first-party mappings land on their source`,
      );
    return { file, debugId };
  });
}

/** Injection skips files that already carry an ID, so a re-run keeps the shipped bytes. */
export function injectServerSourcemaps(dir) {
  sentryCli(["sourcemaps", "inject", dir]);
  return verifyServerSourcemaps(dir);
}

function report(line, annotation = "") {
  console.log(`${annotation}${line}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dir = resolve(process.argv[2] ?? join(ROOT, "dist/server"));
  const ids = injectServerSourcemaps(dir)
    .map(({ file, debugId }) => `${file} ${debugId}`)
    .join(", ");
  const release = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ).version;
  // Same variable and fallback as the `define` in server/tsup.config.ts.
  const dist = process.env.MCPJAM_BUILD_SURFACE || "local";
  const target = `mcpjam-gh/inspector-server release ${release} dist ${dist}`;
  if (!process.env.SENTRY_AUTH_TOKEN?.trim()) {
    console.log(
      `[server-sourcemaps] injected ${ids}; not uploaded: SENTRY_AUTH_TOKEN unset`,
    );
  } else {
    try {
      sentryCli([
        "sourcemaps",
        "upload",
        "--org=mcpjam-gh",
        "--project=inspector-server",
        `--release=${release}`,
        `--dist=${dist}`,
        "--url-prefix=app:///dist/server",
        "--strict",
        "--wait-for=120",
        dir,
      ]);
      report(`[server-sourcemaps] uploaded ${ids} to ${target}`);
    } catch (error) {
      // Reported, not thrown: a Sentry outage must not fail a release or deploy.
      report(
        `[server-sourcemaps] NOT uploaded to ${target}: ${error.message}`,
        "::error::",
      );
    }
  }
}
