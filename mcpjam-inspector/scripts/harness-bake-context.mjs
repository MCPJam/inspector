#!/usr/bin/env node
// Writes the HARNESS BAKE CONTEXT: everything an image build needs to install
// the hosted harness runtimes at build time instead of at turn time.
//
//   node scripts/harness-bake-context.mjs --out <dir>
//   node scripts/harness-bake-context.mjs --write-lock
//   (either takes --lock <path> to read or write a lock elsewhere)
//
// <dir> then holds:
//   claude-code/      the PATCHED Claude Code recipe, byte-identical to what a
//                     hosted turn hands the framework
//   codex-appserver/  the Codex app-server recipe
//   cursor/           the Cursor recipe, whose CLI install is PINNED to one
//                     checksummed build (`cursor-bootstrap.ts`)
//   manifest.json     recipe identities, file digests, the toolchain pins and
//                     `HARNESS_PINNED_VERSIONS`
//   bake.mjs          the in-image installer/verifier (`scripts/harness-bake/bake.mjs`)
//
// `--write-lock` rewrites `harness-bake.lock.json` (next to package.json) from
// the same resolution: the recipe identities, runtime versions and toolchain
// pins the computer template is expected to carry. `--out` REFUSES to write a
// context whose identities differ from the committed lock, so a template can
// only be baked from a commit whose lock describes it.
//
// Consumers: the computer template (mcpjam-backend `templates/computer/`,
// which checks out this repository at the commit in its `inspector-bake-ref`
// file and runs this script) and the hosted-harness CI test image
// (`server/utils/harness/docker/test-image.Dockerfile`). Both copy the
// directory's CONTENTS to `/home/user/.harness-bootstrap/` and run `bake.mjs`
// as the runtime user.
//
// The recipes come from the harness REGISTRY, through the same
// `getHarnessAdapter(id).createHarness(...)` call a hosted turn makes in
// `run-harness-turn.ts`, so the bake follows whatever the hosted adapters build
// (a wrapper added around a recipe is baked the moment the registry uses it).
// This file only IMPORTS those: the recipe sources are signed local-pack
// inputs (`check-local-harness-inputs.mjs`) and nothing here may change their
// bytes. The registry is loaded with the server's tsconfig aliases and the
// SDK's TypeScript sources, so no SDK build is needed. The Codex bridge is read from the
// GENERATED bundle (what the inspector itself imports), after checking it
// equals a fresh bundle of the sources — without rewriting it, since tests may
// be importing it. Identities are computed with `harnessRecipeIdentity`
// (`server/utils/harness/harness-bake.ts`), which `harness-bake.test.ts`
// proves equal to the framework's own.
//
// WHAT CATCHES DRIFT, precisely. `harness-bake.test.ts` compares the
// identities the running inspector resolves with `harness-bake.lock.json` and
// fails when they differ, so a recipe change cannot merge without the lock
// moving with it. The lock moving is the signal to rebuild the computer
// template from that commit and roll it out (mcpjam-backend
// `templates/computer/README.md`, whose `build.ts` only builds from a commit on
// inspector `main`). No check can see whether that rollout happened: until it
// does, hosted turns on the old template install at turn time, and say so in
// their `[harness][timing]` / `[harness][bootstrap]` log fields.
//
// Nothing here depends on the commit or the clock: the same recipes give the
// same bytes, so the template's content hash only moves when something baked
// actually changed.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const BAKE_SCHEMA_VERSION = 1;
export const BAKE_ROOT = "/home/user/.harness-bootstrap";
export const BAKE_RUNTIME_USER = "user";
/** The committed record of what the computer template is expected to bake. */
export const HARNESS_BAKE_LOCK_PATH = join(
  here,
  "..",
  "harness-bake.lock.json",
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Patch sentinels: strings our patcher adds to the Claude Code bridge. Only
 * those actually present in the patched bridge AND absent from the vendor's
 * are recorded, so a patcher change cannot leave the bake checking for
 * something that no longer exists — and a vendor that ships one of them on
 * its own stops being evidence of our patch.
 */
const CLAUDE_CODE_PATCH_SENTINEL_CANDIDATES = [
  "emitAssistantTextFallback",
  "gatewayModelOverrideSettingsFor",
  "strictMcpConfig: true",
  "mcpjamTypedTerminalError",
  "mcpjamBackgroundDrainReducer",
  "mcpjamForwardSubagentStep",
];

async function tsModule(path) {
  const { tsImport } = await import("tsx/esm/api");
  return tsImport(path, { parentURL: import.meta.url, tsconfig: false });
}

/**
 * The recipe's files as `{ name, content }`, `name` relative to the recipe
 * directory. Most recipes are flat; the Cursor recipe also carries its CLI
 * installer under `implementation/`, so a name may have path segments — but
 * never an empty, `.` or `..` one, and never a backslash: the name is joined
 * onto the directory the bake writes into.
 */
function recipeFiles(recipe) {
  const prefix = `${recipe.bootstrapDir}/`;
  return recipe.files.map((file) => {
    const name = file.path.slice(prefix.length);
    if (
      !file.path.startsWith(prefix) ||
      !name ||
      name.includes("\\") ||
      name.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(
        `Unexpected ${recipe.harnessId} bootstrap path: ${file.path}`,
      );
    }
    return { name, content: file.content };
  });
}

const SDK_SOURCE = join(here, "..", "..", "sdk", "src");

let registryPromise;
/**
 * The harness registry, loaded the way the server resolves it: the server
 * tsconfig's aliases, and `@mcpjam/sdk/*` read from the SDK's TypeScript
 * sources (the server tsconfig maps it there too) rather than a built `dist/`.
 */
function loadHarnessRegistry() {
  registryPromise ??= (async () => {
    if (typeof registerHooks !== "function") {
      throw new Error(
        "the bake context generator needs Node >= 22.15 (module.registerHooks)",
      );
    }
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const match = /^@mcpjam\/sdk(?:\/(.+))?$/.exec(specifier);
        if (match) {
          const sub = match[1] ?? "index";
          for (const candidate of [
            join(SDK_SOURCE, `${sub}.ts`),
            join(SDK_SOURCE, sub, "index.ts"),
          ]) {
            if (existsSync(candidate)) {
              return { url: pathToFileURL(candidate).href, shortCircuit: true };
            }
          }
        }
        return nextResolve(specifier, context);
      },
    });
    const { tsImport } = await import("tsx/esm/api");
    return tsImport("../server/utils/harness/registry.ts", {
      parentURL: import.meta.url,
      tsconfig: join(here, "..", "server", "tsconfig.json"),
    });
  })();
  return registryPromise;
}

/**
 * The arguments a hosted turn hands `createHarness`. The values are
 * placeholders: `harness-bake.test.ts` proves no recipe depends on the model,
 * the credentials, the MCP servers, the effort or the command sandbox policy.
 */
const HOSTED_HARNESS_ARGS = {
  "claude-code": {
    modelId: "anthropic/claude-sonnet-4-5",
    auth: {
      ANTHROPIC_AUTH_TOKEN: "bake",
      ANTHROPIC_BASE_URL: "http://bake.invalid",
    },
    mcpJson: { mcpServers: {} },
  },
  codex: {
    modelId: "openai/gpt-5.5",
    auth: { CODEX_API_KEY: "bake", OPENAI_BASE_URL: "http://bake.invalid" },
  },
  cursor: {
    auth: { CURSOR_API_KEY: "bake" },
    mcpJson: { mcpServers: {} },
  },
};

/** A recipe exactly as the registry's hosted adapter builds it. */
async function loadHostedRecipe(harnessId) {
  const registry = await loadHarnessRegistry();
  const harness = registry
    .getHarnessAdapter(harnessId)
    .createHarness(HOSTED_HARNESS_ARGS[harnessId]);
  return { bootstrap: await harness.getBootstrap() };
}

/** The patched Claude Code recipe exactly as a hosted turn builds it. */
async function loadClaudeCodeRecipe() {
  return loadHostedRecipe("claude-code");
}

/**
 * The Codex app-server recipe exactly as a hosted turn builds it, refusing a
 * generated bridge bundle that has drifted from its sources (it is a build
 * product, gitignored, and a stale one would bake a bridge nobody reviewed).
 */
async function loadCodexAppServerRecipe() {
  const generatedPath = join(
    here,
    "../server/utils/harness/codex-appserver/bootstrap/generated/codex-appserver-bridge.bundled.ts",
  );
  if (!existsSync(generatedPath)) {
    throw new Error(
      "the Codex bridge bundle has not been generated; run " +
        "`npm run bundle:codex-appserver-bridge` (or `npm run pretest`) first",
    );
  }
  const { bundleCodexAppServerBridgeSources } =
    await import("./bundle-codex-appserver-bridge.mjs");
  const fresh = await bundleCodexAppServerBridgeSources();
  const generated = await tsModule(
    "../server/utils/harness/codex-appserver/bootstrap/generated/codex-appserver-bridge.bundled.ts",
  );
  if (
    fresh.bridgeSource !== generated.CODEX_APPSERVER_BRIDGE_SOURCE ||
    fresh.hostToolsSource !== generated.CODEX_APPSERVER_HOST_TOOLS_MCP_SOURCE
  ) {
    throw new Error(
      "the generated Codex bridge bundle is stale; run " +
        "`npm run bundle:codex-appserver-bridge` and try again",
    );
  }
  return loadHostedRecipe("codex");
}

function readPins() {
  const pins = JSON.parse(
    readFileSync(join(here, "local-harness-toolchain.json"), "utf8"),
  );
  for (const name of ["node", "pnpm"]) {
    if (!/^\d+\.\d+\.\d+$/.test(pins[name] ?? "")) {
      throw new Error(`local-harness-toolchain.json has no valid ${name} pin`);
    }
  }
  return { node: pins.node, pnpm: pins.pnpm };
}

/**
 * Resolve every recipe and the manifest, without writing anything. Exported
 * for the generator below and for anything that wants to compare.
 */
export async function resolveHarnessBake() {
  const bake = await tsModule("../server/utils/harness/harness-bake.ts");
  const { HARNESS_PINNED_VERSIONS } = await tsModule(
    "../shared/harness-model-support.ts",
  );
  const toolchain = readPins();
  // Node must agree with the toolchain file. pnpm deliberately does not: the
  // hosted pin is memory-bound (see HARNESS_TEMPLATE_PNPM_VERSION), and the
  // template and the inspector's own pnpm fallback both use it.
  if (toolchain.node !== bake.HARNESS_TEMPLATE_NODE_VERSION) {
    throw new Error(
      `harness-bake.ts pins node ${bake.HARNESS_TEMPLATE_NODE_VERSION}, but ` +
        `local-harness-toolchain.json pins ${toolchain.node}`,
    );
  }
  const pins = {
    node: bake.HARNESS_TEMPLATE_NODE_VERSION,
    pnpm: bake.HARNESS_TEMPLATE_PNPM_VERSION,
  };

  const registry = await loadHarnessRegistry();
  const { createClaudeCode } = await import("@ai-sdk/harness-claude-code");
  const vendorClaudeBootstrap = await createClaudeCode().getBootstrap();
  const vendorClaudeBridge =
    vendorClaudeBootstrap.files.find((f) => f.path.endsWith("/bridge.mjs"))
      ?.content ?? "";

  const codexChecksums = JSON.parse(
    readFileSync(
      join(here, "local-harness-pack-recipes", "codex-vendor-checksums.json"),
      "utf8",
    ),
  );

  const sources = [
    {
      loadRecipe: loadClaudeCodeRecipe,
      runtimeVersion: HARNESS_PINNED_VERSIONS["claude-code"],
      vendor: {
        kind: "claude-agent-sdk",
        package: "@anthropic-ai/claude-agent-sdk",
      },
      sentinels: (bridge) =>
        CLAUDE_CODE_PATCH_SENTINEL_CANDIDATES.filter(
          (s) => bridge.includes(s) && !vendorClaudeBridge.includes(s),
        ),
    },
    {
      loadRecipe: loadCodexAppServerRecipe,
      runtimeVersion: HARNESS_PINNED_VERSIONS.codex,
      vendor: {
        kind: "codex-checksums",
        package: "@openai/codex",
        // Linux only: the template is a Linux box. Both architectures, so an
        // arm64 CI image verifies as strictly as the amd64 template.
        platforms: Object.fromEntries(
          ["linux-x64", "linux-arm64"].map((key) => [key, codexChecksums[key]]),
        ),
      },
      sentinels: () => [],
    },
    {
      loadRecipe: () => loadHostedRecipe("cursor"),
      runtimeVersion: HARNESS_PINNED_VERSIONS.cursor,
      vendor: {
        kind: "cursor-cli",
        version: registry.CURSOR_CLI_VERSION,
        // Linux only: the template is a Linux box. Both architectures, so an
        // arm64 CI image verifies as strictly as the amd64 template. The
        // archive itself is checksummed inside the recipe's installer; the
        // manifest records the same digests so the bake can assert the
        // installer it ran is the one the inspector resolves.
        platforms: {
          "linux-x64": { archiveSha256: registry.CURSOR_CLI_CHECKSUMS.x64 },
          "linux-arm64": { archiveSha256: registry.CURSOR_CLI_CHECKSUMS.arm64 },
        },
      },
      sentinels: () => [],
    },
  ];

  const recipes = [];
  for (const source of sources) {
    const { bootstrap } = await source.loadRecipe();
    const files = recipeFiles(bootstrap);
    const bridge = files.find((file) => file.name === "bridge.mjs");
    if (!bridge)
      throw new Error(`${bootstrap.harnessId} recipe has no bridge.mjs`);
    const sentinels = source.sentinels(bridge.content);
    if (bootstrap.harnessId === "claude-code" && sentinels.length === 0) {
      throw new Error(
        "the Claude Code bridge carries none of the MCPJam patch sentinels; " +
          "refusing to bake a bridge that may be the vendor's",
      );
    }
    const identity = bake.harnessRecipeIdentity(bootstrap);
    recipes.push({
      harnessId: bootstrap.harnessId,
      runtimeVersion: source.runtimeVersion,
      bootstrapDir: bootstrap.bootstrapDir,
      dir: bootstrap.bootstrapDir.split("/").pop(),
      identity,
      marker: bake.harnessBootstrapMarkerName(identity),
      files: files
        .map((file) => ({
          name: file.name,
          sha256: sha256(file.content),
          bytes: Buffer.byteLength(file.content),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      commands: bootstrap.commands,
      bridge: {
        name: "bridge.mjs",
        sha256: sha256(bridge.content),
        sentinels,
      },
      vendor: source.vendor,
      contents: files,
    });
  }

  for (const recipe of recipes) {
    if (!bake.HARNESS_BAKED_BOOTSTRAP_DIRS.includes(recipe.bootstrapDir)) {
      throw new Error(
        `${recipe.bootstrapDir} is baked but not listed in HARNESS_BAKED_BOOTSTRAP_DIRS, ` +
          "so the inspector would report its turns as unbaked",
      );
    }
  }

  const body = {
    schemaVersion: BAKE_SCHEMA_VERSION,
    bakedBy: bake.HARNESS_BAKED_MARKER_AUTHOR,
    home: bake.HARNESS_BAKE_HOME,
    bakeRoot: BAKE_ROOT,
    runtimeUser: BAKE_RUNTIME_USER,
    pins,
    harnessPinnedVersions: HARNESS_PINNED_VERSIONS,
    recipes: recipes.map(({ contents: _contents, ...recipe }) => recipe),
  };
  const bakeScript = readFileSync(join(here, "harness-bake", "bake.mjs"));
  // The bake id covers what the image installs AND how: the recipes (through
  // their digests), the pins, and the installer itself.
  const bakeId = sha256(JSON.stringify(body) + "\0" + sha256(bakeScript)).slice(
    0,
    12,
  );
  const manifest = { ...body, bakeId };
  return { manifest, recipes, bakeScript };
}

/**
 * The lock: the part of a manifest that decides whether a turn on the
 * template hits its marker (identities), plus the versions a reviewer reads
 * (runtime versions and toolchain pins). Deliberately NOT the bake id: an
 * installer-only change does not move any marker, and must not demand a
 * template rebuild.
 */
export function harnessBakeLockFor(manifest) {
  return {
    comment:
      "Recipe identities the MCPJam computer template is expected to bake. " +
      "Regenerate with `node scripts/harness-bake-context.mjs --write-lock`; " +
      "a change here means the template must be rebuilt from this commit and " +
      "rolled out (mcpjam-backend templates/computer/README.md).",
    pins: { node: manifest.pins.node, pnpm: manifest.pins.pnpm },
    recipes: manifest.recipes
      .map((recipe) => ({
        harnessId: recipe.harnessId,
        bootstrapDir: recipe.bootstrapDir,
        identity: recipe.identity,
        runtimeVersion: recipe.runtimeVersion,
      }))
      .sort((a, b) =>
        a.bootstrapDir < b.bootstrapDir
          ? -1
          : a.bootstrapDir > b.bootstrapDir
            ? 1
            : 0,
      ),
  };
}

/**
 * Write the bake context to `outDir`. Refuses to overwrite a non-empty
 * directory it did not write (no `manifest.json`), so a wrong `--out` cannot
 * delete someone's work.
 */
export async function writeHarnessBakeContext(outDir, resolved) {
  const target = resolve(outDir);
  if (existsSync(target) && readdirSync(target).length > 0) {
    if (!existsSync(join(target, "manifest.json"))) {
      throw new Error(
        `${target} is not empty and holds no bake manifest; refusing to overwrite it`,
      );
    }
    rmSync(target, { recursive: true, force: true });
  }
  const { manifest, recipes, bakeScript } =
    resolved ?? (await resolveHarnessBake());
  mkdirSync(target, { recursive: true });
  for (const recipe of recipes) {
    const dir = join(target, recipe.dir);
    mkdirSync(dir, { recursive: true });
    for (const file of recipe.contents) {
      const path = join(dir, file.name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
  }
  writeFileSync(join(target, "bake.mjs"), bakeScript);
  writeFileSync(
    join(target, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/**
 * Throw unless `lock` (from {@link harnessBakeLockFor}) is what the committed
 * lock at `lockPath` records: a context that differs would bake a template
 * the lock does not describe.
 */
export function assertMatchesCommittedLock(lock, lockPath) {
  const committed = existsSync(lockPath)
    ? JSON.parse(readFileSync(lockPath, "utf8"))
    : undefined;
  const recorded = JSON.stringify({
    pins: committed?.pins,
    recipes: committed?.recipes,
  });
  const resolved = JSON.stringify({ pins: lock.pins, recipes: lock.recipes });
  if (recorded !== resolved) {
    throw new Error(
      `the recipes this commit resolves do not match ${lockPath}; refusing to ` +
        "write a bake context the lock does not describe.\n" +
        `  lock:     ${recorded}\n  resolved: ${resolved}\n` +
        "Run `node scripts/harness-bake-context.mjs --write-lock`, commit the " +
        "lock, and rebuild the computer template from the merged commit.",
    );
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const out = argValue("--out");
  const lockPath = resolve(argValue("--lock") ?? HARNESS_BAKE_LOCK_PATH);
  const writeLock = process.argv.includes("--write-lock");
  if (!out && !writeLock) {
    throw new Error(
      "usage: node scripts/harness-bake-context.mjs [--out <dir>] [--write-lock] [--lock <path>]",
    );
  }
  const resolved = await resolveHarnessBake();
  const { manifest } = resolved;
  const lock = harnessBakeLockFor(manifest);
  if (writeLock) {
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    process.stdout.write(`lock written to ${lockPath}\n`);
  }
  if (out) {
    assertMatchesCommittedLock(lock, lockPath);
    await writeHarnessBakeContext(out, resolved);
    process.stdout.write(
      `harness bake ${manifest.bakeId} written to ${resolve(out)}\n`,
    );
  }
  process.stdout.write(
    manifest.recipes
      .map(
        (r) =>
          `  ${r.bootstrapDir} ${r.runtimeVersion} identity=${r.identity}\n`,
      )
      .join("") + `  node ${manifest.pins.node}, pnpm ${manifest.pins.pnpm}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
