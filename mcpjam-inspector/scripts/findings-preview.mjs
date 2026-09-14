#!/usr/bin/env node
/**
 * `npm run findings:preview` — start the offline unified-findings preview.
 *
 *   npm run findings:preview -- --replay /tmp/unified-findings-replay.json
 *
 * Copies the artifact next to the preview's Vite root (so it is served as a
 * plain static file, with no build-time import and no bundling of evidence)
 * and starts Vite on it. No Convex URL, no auth, no model key, no SDK build.
 *
 * `--build` writes a static bundle instead of starting a server, for taking
 * screenshots in CI or on a machine with no free port.
 */
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const previewDir = resolve(here, "../client/dev/findings-preview");
const target = resolve(previewDir, "replay.json");

/** 32 MiB. A replay artifact for the corpus is ~1 MiB; far past that is not
 * one of ours, and bundling it into a dev server helps nobody. */
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

function usage() {
  console.log(
    [
      "findings:preview — render backend replay output with the app's own components.",
      "",
      "  --replay <path>   the artifact written by `npm run findings:replay`",
      "                    in the paired mcpjam-backend checkout (required",
      "                    unless one was copied in by an earlier run)",
      "  --build           build a static bundle instead of serving",
      "  --port <n>        dev server port (default 5175)",
      "",
      "Example:",
      "  # in mcpjam-backend",
      "  npm run findings:replay -- --fixtures --out /tmp/unified-findings-replay.json",
      "  # in inspector",
      "  npm run findings:preview -- --replay /tmp/unified-findings-replay.json",
    ].join("\n"),
  );
}

function fail(message) {
  console.error(`findings:preview: ${message}`);
  usage();
  process.exit(1);
}

const argv = process.argv.slice(2);
let replay = null;
let build = false;
let port = process.env.FINDINGS_PREVIEW_PORT ?? "5175";
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--replay") {
    replay = argv[++i] ?? fail("--replay needs a path");
  } else if (arg === "--build") {
    build = true;
  } else if (arg === "--port") {
    port = argv[++i] ?? fail("--port needs a number");
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    fail(`unrecognized argument "${arg}"`);
  }
}

if (replay) {
  const source = resolve(process.cwd(), replay);
  if (!existsSync(source)) {
    fail(
      `${source} does not exist. Run \`npm run findings:replay -- --fixtures --out <path>\` in the mcpjam-backend checkout first.`,
    );
  }
  const { size } = statSync(source);
  if (size > MAX_ARTIFACT_BYTES) {
    fail(`${source} is ${size} bytes, past the ${MAX_ARTIFACT_BYTES}-byte limit`);
  }
  rmSync(target, { force: true });
  copyFileSync(source, target);
  console.log(`findings:preview: loaded ${source} (${(size / 1024).toFixed(1)} KiB)`);
} else if (!existsSync(target)) {
  fail(
    "no artifact loaded yet. Pass --replay <path> pointing at the output of `npm run findings:replay` in the mcpjam-backend checkout.",
  );
} else {
  console.log("findings:preview: reusing the artifact from a previous run");
}

const args = build
  ? ["vite", "build", "--config", resolve(previewDir, "vite.config.ts")]
  : [
      "vite",
      "--config",
      resolve(previewDir, "vite.config.ts"),
      "--port",
      String(port),
    ];

const child = spawn("npx", args, {
  stdio: "inherit",
  env: { ...process.env, FINDINGS_PREVIEW_PORT: String(port) },
});
child.on("exit", (code) => {
  // A dev server serves `replay.json` straight out of the Vite root; a BUILD
  // does not copy it (it is deliberately not in a `public/` dir, so evidence
  // is never bundled). Copy it beside the bundle so the static output is
  // openable the same way the dev server is.
  if (build && (code ?? 0) === 0) {
    const dist = resolve(previewDir, "dist");
    if (existsSync(dist)) {
      copyFileSync(target, resolve(dist, "replay.json"));
      console.log(`findings:preview: wrote ${dist}`);
    }
  }
  process.exit(code ?? 0);
});
