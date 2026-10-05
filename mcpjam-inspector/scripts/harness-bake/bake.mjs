// The in-image half of the harness bake. Runs ONCE, at image build time,
// inside the computer template (mcpjam-backend `templates/computer/`) and the
// hosted-harness CI test image, AS THE RUNTIME USER, from the directory the
// bake context was copied into (`/home/user/.harness-bootstrap`).
//
// What it does, for each recipe in `manifest.json`:
//   1. checks every copied file against the digest the generator recorded —
//      a truncated or stale COPY is a box that installs on every turn;
//   2. checks the bridge is the PATCHED one (its bytes, plus patch sentinels
//      the vendor bridge does not contain);
//   3. runs the recipe's own commands, verbatim, in the recipe directory —
//      exactly what `applyBootstrapRecipe` would have run at turn time;
//   4. verifies the vendor binary against what vouches for it (the Claude
//      Agent SDK's published checksums; MCPJam's recorded Codex checksums),
//      and that the bridge's imports resolve and load;
//   5. only then writes the success marker the framework looks for.
//
// A failure anywhere fails the image build. That is the point: an image that
// built "successfully" with a broken bake is indistinguishable from a good one
// until every turn on it silently falls back to installing — or does not
// start at all.
//
// Plain Node, no dependencies: it runs before anything is installed.
import { createHash } from "node:crypto";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { arch, userInfo } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

const log = (message) => process.stdout.write(`[harness-bake] ${message}\n`);
function fail(message) {
  process.stderr.write(`[harness-bake] FAILED: ${message}\n`);
  process.exit(1);
}
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const bare = (digest) => String(digest).replace(/^sha256[:-]/, "");

if (manifest.schemaVersion !== 1) {
  fail(`unsupported bake manifest schema ${manifest.schemaVersion}`);
}

// ── Where, and as whom ──────────────────────────────────────────────────────
// The framework resolves `.harness-bootstrap/<id>` against the box's working
// directory, so a context copied anywhere else is a bake no turn will find.
if (root !== manifest.bakeRoot) {
  fail(
    `the bake context is at ${root}, but markers are only found at ` +
      `${manifest.bakeRoot}. Copy the context's CONTENTS there ` +
      "(`COPY harness-bake/ /home/user/.harness-bootstrap/`).",
  );
}
// The runtime user, not root: a recipe installed by root is a directory the
// harness cannot rewrite after drift, and a vendor binary that only root can
// read is a binary that does not run.
const me = userInfo();
if (me.uid === 0 || me.username !== manifest.runtimeUser) {
  fail(
    `running as ${me.username} (uid ${me.uid}); the bake must run as ` +
      `${manifest.runtimeUser}, the user every harness turn runs as`,
  );
}

// ── Toolchain pins ──────────────────────────────────────────────────────────
if (process.versions.node !== manifest.pins.node) {
  fail(
    `node ${process.versions.node} is installed; the bake pins ${manifest.pins.node}`,
  );
}
const pnpmVersion = execFileSync("pnpm", ["--version"], {
  encoding: "utf8",
}).trim();
if (pnpmVersion !== manifest.pins.pnpm) {
  fail(`pnpm ${pnpmVersion} is installed; the bake pins ${manifest.pins.pnpm}`);
}
log(`node ${process.versions.node}, pnpm ${pnpmVersion}, user ${me.username}`);

const platformKey = `linux-${arch()}`;

function verifyFiles(recipe, dir) {
  for (const file of recipe.files) {
    const path = join(dir, file.name);
    if (!existsSync(path)) fail(`${recipe.dir}/${file.name} was not copied`);
    const bytes = statSync(path).size;
    const digest = sha256(path);
    if (digest !== file.sha256 || bytes !== file.bytes) {
      fail(
        `${recipe.dir}/${file.name} does not match the bake manifest ` +
          `(${bytes} bytes, sha256 ${digest}; expected ${file.bytes}, ${file.sha256})`,
      );
    }
  }
}

function verifyPatchedBridge(recipe, dir) {
  const path = join(dir, recipe.bridge.name);
  const digest = sha256(path);
  if (digest !== recipe.bridge.sha256) {
    fail(
      `${recipe.dir}/${recipe.bridge.name} is not the bridge the inspector resolves (sha256 ${digest})`,
    );
  }
  const source = readFileSync(path, "utf8");
  for (const sentinel of recipe.bridge.sentinels ?? []) {
    if (!source.includes(sentinel)) {
      fail(
        `${recipe.dir}/${recipe.bridge.name} is missing the MCPJam patch "${sentinel}"`,
      );
    }
  }
  const check = spawnSync(process.execPath, ["--check", path], {
    encoding: "utf8",
  });
  if (check.status !== 0) {
    fail(`${recipe.dir}/${recipe.bridge.name} does not parse: ${check.stderr}`);
  }
}

/** Every bare import of the bridge resolves from the recipe directory AND
 *  loads — an install that "succeeded" without a dependency the bridge needs
 *  fails here instead of at the first turn's bridge start. */
function verifyBridgeImports(recipe, dir) {
  const source = readFileSync(join(dir, recipe.bridge.name), "utf8");
  const specifiers = new Set();
  for (const match of source.matchAll(
    /(?:^|[\s;])(?:import|export)\b[^'"]*?\bfrom\s*["']([^"'./][^"']*)["']|\bimport\(\s*["']([^"'./][^"']*)["']\s*\)/gm,
  )) {
    const spec = match[1] ?? match[2];
    if (spec && !spec.startsWith("node:")) specifiers.add(spec);
  }
  const builtins = new Set(builtinModules);
  for (const spec of specifiers) {
    if (builtins.has(spec) || builtins.has(spec.split("/")[0])) continue;
    const loaded = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(spec)});`],
      { cwd: dir, encoding: "utf8" },
    );
    if (loaded.status !== 0) {
      fail(
        `${recipe.dir}: the bridge imports "${spec}", which does not load: ${loaded.stderr.trim().slice(-400)}`,
      );
    }
  }
  log(
    `${recipe.dir}: bridge imports load (${[...specifiers].sort().join(", ") || "none"})`,
  );
}

function walk(rootDir) {
  const out = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else out.push(relative(rootDir, path).split(sep).join("/"));
    }
  };
  visit(rootDir);
  return out.sort();
}

function verifyVendor(recipe, dir) {
  const vendor = recipe.vendor;
  if (vendor.kind === "claude-agent-sdk") {
    // The binary the bridge actually runs: the SDK spawns its OWN platform
    // package's native CLI. Checked against the checksums the SDK publishes in
    // its manifest — the same check the local pack build makes.
    const sdkDir = realpathSync(
      join(dir, "node_modules", ...vendor.package.split("/")),
    );
    const sdkManifest = JSON.parse(
      readFileSync(join(sdkDir, "manifest.json"), "utf8"),
    );
    const entry = sdkManifest?.platforms?.[platformKey];
    if (!entry?.checksum || !entry?.binary) {
      fail(`the Claude Agent SDK lists no checksum for ${platformKey}`);
    }
    if (sdkManifest.version !== recipe.runtimeVersion) {
      fail(
        `the Claude Agent SDK bundles Claude Code ${sdkManifest.version}; the inspector pins ${recipe.runtimeVersion}`,
      );
    }
    const platformPackage = dirname(
      createRequire(join(sdkDir, "package.json")).resolve(
        `${vendor.package}-${platformKey}/package.json`,
      ),
    );
    const binary = join(platformPackage, entry.binary);
    const digest = sha256(binary);
    if (digest !== bare(entry.checksum)) {
      fail(
        `Claude Code CLI checksum mismatch for ${platformKey}: SDK says ${bare(entry.checksum)}, file hashes to ${digest}`,
      );
    }
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8",
    }).trim();
    if (!version.includes(recipe.runtimeVersion)) {
      fail(`the vendor CLI reports "${version}", not ${recipe.runtimeVersion}`);
    }
    log(
      `${recipe.dir}: vendor CLI ${version} verified (${digest.slice(0, 12)})`,
    );
    return;
  }
  if (vendor.kind === "codex-checksums") {
    // EVERY file of the platform package — the binary, rg, bwrap and the rest
    // all run — against the checksums recorded from the published tarball.
    const expected = vendor.platforms?.[platformKey];
    if (!expected?.files)
      fail(`no Codex checksums are recorded for ${platformKey}`);
    const wrapperDir = realpathSync(
      join(dir, "node_modules", ...vendor.package.split("/")),
    );
    const wrapper = JSON.parse(
      readFileSync(join(wrapperDir, "package.json"), "utf8"),
    );
    if (wrapper.version !== recipe.runtimeVersion) {
      fail(
        `@openai/codex ${wrapper.version} is installed; the inspector pins ${recipe.runtimeVersion}`,
      );
    }
    const platformDir = dirname(
      createRequire(join(wrapperDir, "package.json")).resolve(
        `${vendor.package}-${platformKey}/package.json`,
      ),
    );
    const actual = walk(platformDir);
    const recorded = Object.keys(expected.files).sort();
    const missing = recorded.filter((path) => !actual.includes(path));
    const extra = actual.filter((path) => !recorded.includes(path));
    if (missing.length > 0 || extra.length > 0) {
      fail(
        `${vendor.package}-${platformKey} does not match its recorded file list (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
      );
    }
    for (const path of recorded) {
      const record = expected.files[path];
      const absolute = join(platformDir, path);
      if (
        sha256(absolute) !== bare(record.sha256) ||
        statSync(absolute).size !== record.bytes
      ) {
        fail(`checksum mismatch for ${vendor.package}-${platformKey}/${path}`);
      }
    }
    log(
      `${recipe.dir}: ${recorded.length} vendor files verified for ${platformKey}`,
    );
    return;
  }
  fail(`unknown vendor verification "${vendor.kind}" for ${recipe.dir}`);
}

for (const recipe of manifest.recipes) {
  const dir = join(root, recipe.dir);
  log(
    `${recipe.dir}: baking ${recipe.harnessId} ${recipe.runtimeVersion} (identity ${recipe.identity})`,
  );
  verifyFiles(recipe, dir);
  verifyPatchedBridge(recipe, dir);
  for (const { command } of recipe.commands) {
    log(`${recipe.dir}: $ ${command}`);
    try {
      execSync(command, { cwd: dir, stdio: "inherit", shell: "/bin/sh" });
    } catch (error) {
      fail(
        `${recipe.dir}: recipe command failed: ${command} (${error.status ?? error.message})`,
      );
    }
  }
  verifyVendor(recipe, dir);
  verifyBridgeImports(recipe, dir);
  // LAST, and only on success. The framework skips the install when this
  // file exists, whatever it contains; the JSON is for the inspector's
  // observer, which reads it to tell a baked box from one a turn installed.
  writeFileSync(
    join(dir, recipe.marker),
    `${JSON.stringify({
      bakedBy: manifest.bakedBy,
      harnessId: recipe.harnessId,
      identity: recipe.identity,
      bakeId: manifest.bakeId,
      versions: {
        [recipe.harnessId]: recipe.runtimeVersion,
        node: manifest.pins.node,
        pnpm: manifest.pins.pnpm,
      },
    })}\n`,
  );
  log(`${recipe.dir}: wrote ${recipe.marker}`);
}
log(`bake ${manifest.bakeId} complete`);
