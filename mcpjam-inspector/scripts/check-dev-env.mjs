#!/usr/bin/env node
/**
 * Fail loudly, and early, on the environment problems that otherwise fail
 * silently.
 *
 * Every check here exists because something produced no output and no error:
 * `electron:make` on Node 26 exits 0 and writes no `out/` (extract-zip never
 * settles); the DMG maker dies on `macos-alias`/`fs-xattr` native addons that
 * were never compiled, because they are optional deps and `npm install`
 * succeeds without them; `electron:package` without `dist/client` produces a
 * bundle missing its UI.
 *
 * ONE RULE GOVERNS THE SEVERITY TABLE, and it is what keeps this guard from
 * becoming the problem it was written to solve: **only the packaging path may
 * hard-fail; the dev path only ever warns.** Node 26 dev may well work. Node 26
 * packaging demonstrably produces nothing. A guard that blocks someone's
 * `electron:dev` over a version we merely distrust has cost more than it saved.
 *
 *                                      dev    package   make
 *   Node major > .nvmrc                warn    ERROR    ERROR
 *   Node major < engines floor         warn    ERROR    ERROR
 *   DMG addons missing (darwin)         -        -      ERROR
 *   dist/client or ../sdk/dist missing  -      ERROR    ERROR
 *   Port 6274 already taken            warn      -        -
 *   .env.development missing           warn      -        -
 *
 * Output is ASCII-only: Windows CI runs `electron:make`, and a mangled box
 * character in a failure message is a second mystery on top of the first.
 *
 * Escape hatches:
 *   MCPJAM_ALLOW_UNSUPPORTED_NODE=1  skip both Node version checks
 *   MCPJAM_SKIP_DMG_CHECK=1          skip the macOS DMG addon probe
 *
 * Flags (the `--pretend-*` pair exists so the severity table can be exercised
 * from a test or by hand without installing four Node versions):
 *   --task=dev|electron-dev|electron-package|electron-make
 *   --pretend-node=26.3.0
 *   --pretend-platform=win32
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Every task this guard knows how to evaluate. */
export const TASKS = [
  "dev",
  "electron-dev",
  "electron-package",
  "electron-make",
];

/** Tasks that produce a shippable artifact, and so may hard-fail. */
const PACKAGING_TASKS = new Set(["electron-package", "electron-make"]);

/** Native addons the macOS DMG maker needs, both optional deps of maker-dmg. */
const DMG_ADDONS = ["macos-alias", "fs-xattr"];

const PORT = 6274;

/**
 * Why a too-new Node is worth a paragraph: the Homebrew detail is the one
 * people lose an afternoon to. `brew install node@24` and `node@25` have both
 * shipped formulae whose `bin/node` symlinks into the Node 26 keg, so `node -v`
 * reports 26 right after you "installed 24" and the error looks like it ignored
 * you.
 */
function nodeFix(target) {
  return [
    `nvm install ${target} && nvm use`,
    `  (or: fnm use ${target} / volta pin node@${target})`,
    `  Note: Homebrew's node@24 and node@25 formulae have both symlinked to`,
    `  Node 26 -- check 'node -v' after installing, not just the formula name.`,
  ].join("\n");
}

function majorOf(version) {
  const match = /^v?(\d+)\./.exec(String(version ?? "").trim());
  return match ? Number(match[1]) : null;
}

/**
 * Lowest Node major allowed by a package.json `engines.node` range.
 * Deliberately minimal: this only ever reads our own `">=22.0.0"`, and pulling
 * in a semver range parser to learn that would be the larger risk.
 */
function floorMajorOf(range) {
  const match = /(\d+)/.exec(String(range ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * Classify a set of already-gathered environment facts. Pure: no file system,
 * no network, no `process`. The probes live in `main()` below, so this half can
 * be unit-tested across tasks and platforms that the test machine is not.
 *
 * @param {object} input
 * @param {string} input.task                     one of TASKS
 * @param {string} input.nodeVersion              e.g. "v24.14.0" or "26.3.0"
 * @param {string} input.platform                 process.platform spelling
 * @param {string} [input.nvmrcVersion]           contents of .nvmrc
 * @param {string} [input.enginesNodeRange]       package.json engines.node
 * @param {boolean} [input.allowUnsupportedNode]  MCPJAM_ALLOW_UNSUPPORTED_NODE=1
 * @param {boolean} [input.skipDmgCheck]          MCPJAM_SKIP_DMG_CHECK=1
 * @param {Array<{name: string, ok: boolean, reason?: string}>} [input.dmgAddons]
 * @param {Array<{label: string, exists: boolean}>} [input.buildOutputs]
 * @param {boolean} [input.portInUse]
 * @param {boolean} [input.envDevelopmentMissing]
 * @returns {{errors: Array<{code: string, message: string, fix: string}>,
 *            warnings: Array<{code: string, message: string, fix: string}>}}
 */
export function evaluateDevEnv(input) {
  const {
    task,
    nodeVersion,
    platform,
    nvmrcVersion,
    enginesNodeRange,
    allowUnsupportedNode = false,
    skipDmgCheck = false,
    dmgAddons = [],
    buildOutputs = [],
    portInUse = false,
    envDevelopmentMissing = false,
  } = input;

  if (!TASKS.includes(task)) {
    throw new Error(
      `Unknown task ${JSON.stringify(task)}; expected one of ${TASKS.join(", ")}`,
    );
  }

  const errors = [];
  const warnings = [];
  const isPackaging = PACKAGING_TASKS.has(task);
  // A finding's severity is decided in exactly one place.
  const add = (fatal, finding) => (fatal ? errors : warnings).push(finding);

  const nodeMajor = majorOf(nodeVersion);
  const pinnedMajor = majorOf(nvmrcVersion);
  const floorMajor = floorMajorOf(enginesNodeRange);
  const pinned = String(nvmrcVersion ?? "").trim() || "24.14.0";

  if (!allowUnsupportedNode && nodeMajor !== null) {
    if (pinnedMajor !== null && nodeMajor > pinnedMajor) {
      add(isPackaging, {
        code: "node-too-new",
        message:
          `Node ${nodeVersion} is newer than the pinned ${pinned} (.nvmrc).` +
          (isPackaging
            ? ` Packaging on Node ${nodeMajor} produces NO output and still exits 0:` +
              ` extract-zip never settles, so electron-forge writes no out/ and reports success.`
            : ` Dev usually works; packaging on this major does not.`),
        fix: nodeFix(pinned),
      });
    } else if (floorMajor !== null && nodeMajor < floorMajor) {
      add(isPackaging, {
        code: "node-too-old",
        message: `Node ${nodeVersion} is below this package's engines floor (>=${floorMajor}).`,
        fix: nodeFix(pinned),
      });
    }
  }

  if (task === "electron-make" && platform === "darwin" && !skipDmgCheck) {
    for (const addon of dmgAddons) {
      if (addon.ok) continue;
      errors.push({
        code: "dmg-addon-unusable",
        message:
          `The DMG maker's native addon '${addon.name}' cannot be loaded` +
          `${addon.reason ? `: ${addon.reason}.` : "."}` +
          ` It is an optional dependency, so 'npm install' succeeded without` +
          ` compiling it and the failure only surfaces inside the maker.`,
        fix: "npm run electron:fix:dmg-deps -w @mcpjam/inspector",
      });
    }
  }

  if (isPackaging) {
    for (const output of buildOutputs) {
      if (output.exists) continue;
      errors.push({
        code: "build-output-missing",
        message: `${output.label} is missing; it is packaged into the app as a resource.`,
        fix: "npm run build -w @mcpjam/inspector",
      });
    }
  }

  if (!isPackaging) {
    if (portInUse) {
      warnings.push({
        code: "port-busy",
        message:
          `Port ${PORT} is already in use. The Electron renderer proxies /api to a` +
          ` hardcoded localhost:${PORT}, so a separate 'npm run dev' already holding it` +
          ` will serve that server's responses into this window.`,
        fix: `Stop the other process first (lsof -ti tcp:${PORT} | xargs kill)`,
      });
    }
    if (envDevelopmentMissing) {
      warnings.push({
        code: "env-development-missing",
        message:
          ".env.development is missing; dev auth and Convex settings fall back to defaults.",
        fix: "cp mcpjam-inspector/.env.local mcpjam-inspector/.env.development",
      });
    }
  }

  return { errors, warnings };
}

/* ------------------------------------------------------------------ probes */

// Resolve every path from this file, never process.cwd(). npm `pre*` hooks run
// with the package dir as cwd today, but that is not a contract, and the DMG
// addons in particular hoist to the REPO ROOT node_modules -- a cwd-relative
// require would miss them and report a false failure.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const inspectorDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(inspectorDir, "..");
const requireFromScript = createRequire(import.meta.url);

function readFlag(argv, name) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Probe the addons with a real `require()`. A file-existence check passes for a
 * `.node` built against another Node ABI -- the exact state `npm rebuild` fixes
 * and the one that reads as "but the file is right there".
 */
function probeDmgAddons() {
  return DMG_ADDONS.map((name) => {
    try {
      requireFromScript(name);
      return { name, ok: true };
    } catch (error) {
      return {
        name,
        ok: false,
        reason: String(error?.message ?? error).split("\n")[0],
      };
    }
  });
}

function probePortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function report(task, { errors, warnings }) {
  for (const warning of warnings) {
    console.warn(
      `[check-dev-env] WARNING (${warning.code}): ${warning.message}`,
    );
    console.warn(
      `[check-dev-env]   fix: ${warning.fix.replace(/\n/g, "\n[check-dev-env]   ")}`,
    );
  }
  for (const error of errors) {
    console.error(`[check-dev-env] ERROR (${error.code}): ${error.message}`);
    console.error(
      `[check-dev-env]   fix: ${error.fix.replace(/\n/g, "\n[check-dev-env]   ")}`,
    );
  }
  if (errors.length > 0) {
    console.error(
      `[check-dev-env] ${errors.length} blocking problem(s) for '${task}'. ` +
        `Nothing was built. Apply the fix above and re-run.`,
    );
  }
}

async function main(argv) {
  const task = readFlag(argv, "task") ?? "dev";
  const pretendNode = readFlag(argv, "pretend-node");
  const pretendPlatform = readFlag(argv, "pretend-platform");

  if (!TASKS.includes(task)) {
    console.error(
      `[check-dev-env] Unknown --task=${task}; expected one of ${TASKS.join(", ")}`,
    );
    return 1;
  }

  const platform = pretendPlatform ?? process.platform;
  const isPackaging = PACKAGING_TASKS.has(task);
  const skipDmgCheck = process.env.MCPJAM_SKIP_DMG_CHECK === "1";

  const input = {
    task,
    nodeVersion: pretendNode ?? process.version,
    platform,
    nvmrcVersion: readIfPresent(path.join(inspectorDir, ".nvmrc")),
    enginesNodeRange: (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(inspectorDir, "package.json"), "utf8"),
        ).engines?.node;
      } catch {
        return undefined;
      }
    })(),
    allowUnsupportedNode: process.env.MCPJAM_ALLOW_UNSUPPORTED_NODE === "1",
    skipDmgCheck,
    // Probe only what this task can actually be blocked by, so a dev run never
    // pays for a packaging check (and never loads a native addon at all).
    dmgAddons:
      task === "electron-make" && platform === "darwin" && !skipDmgCheck
        ? probeDmgAddons()
        : [],
    buildOutputs: isPackaging
      ? [
          {
            label: "dist/client",
            exists: fs.existsSync(path.join(inspectorDir, "dist", "client")),
          },
          {
            label: "../sdk/dist",
            exists: fs.existsSync(path.join(repoRoot, "sdk", "dist")),
          },
        ]
      : [],
    portInUse: isPackaging ? false : await probePortInUse(PORT),
    envDevelopmentMissing: isPackaging
      ? false
      : !fs.existsSync(path.join(inspectorDir, ".env.development")),
  };

  const result = evaluateDevEnv(input);
  report(task, result);
  return result.errors.length > 0 ? 1 : 0;
}

// Run only when invoked directly, so the pure half above stays importable.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
