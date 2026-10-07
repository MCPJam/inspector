import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";
import {
  HARNESS_BAKED_BOOTSTRAP_DIRS,
  HARNESS_TEMPLATE_NODE_VERSION,
  HARNESS_TEMPLATE_PNPM_VERSION,
  harnessPnpmGuardCommand,
  harnessRecipeIdentity,
  type HarnessBootstrapRecipe,
} from "../harness-bake.js";
import { getHarnessAdapter } from "../registry.js";
import { HOSTED_APPROVAL_SANDBOX_POLICY } from "../codex-appserver/hosted-sandbox-policy.js";
import { HARNESS_PINNED_VERSIONS } from "@/shared/harness-model-support";

// The bake only works if the identity the TEMPLATE baked is the identity the
// RUNNING inspector resolves. Two ways that breaks, both silent in production
// (every box quietly falls back to installing): the framework changes how it
// hashes a recipe, or a recipe changes without a new template. The first is
// pinned against the real framework below. The second is what
// `harness-bake.lock.json` is for: it records the identities the computer
// template is expected to carry, and the lock test fails until a recipe
// change is acknowledged there — the cue to rebuild and roll the template.

const PACKAGE_ROOT = resolve(__dirname, "../../../..");
const LOCK_PATH = join(PACKAGE_ROOT, "harness-bake.lock.json");
const SENTINEL = "stop-after-marker-read";

type HarnessWithBootstrap = {
  getBootstrap: () => Promise<HarnessBootstrapRecipe>;
};
type CreateHarness = (args: unknown) => HarnessWithBootstrap;

/**
 * Drive the REAL framework far enough to see which marker it looks for: a
 * provider whose session records the marker read and then stops the
 * session start. Returns the identity in that path.
 */
async function frameworkMarkerIdentity(harness: unknown): Promise<{
  identity: string;
  bootstrapDir: string;
}> {
  let markerPath: string | undefined;
  const session = {
    id: "probe",
    defaultWorkingDirectory: "/home/user",
    description: "identity probe",
    ports: [39271],
    readTextFile: async ({ path }: { path: string }) => {
      if (/\.bootstrap-[0-9a-f]+\.ok$/.test(path)) {
        markerPath = path;
        throw new Error(SENTINEL);
      }
      return null;
    },
    readBinaryFile: async () => null,
    readFile: async () => null,
    writeTextFile: async () => {},
    writeBinaryFile: async () => {},
    writeFile: async () => {},
    run: async () => ({ exitCode: 0, stdout: "/home/user\n", stderr: "" }),
    spawn: async () => {
      throw new Error("not expected");
    },
    getPortEndpoint: async () => ({ url: "ws://127.0.0.1:1" }),
    getPortUrl: async () => "ws://127.0.0.1:1",
    stop: async () => {},
    destroy: async () => {},
    restricted: () => session,
  };
  const provider: HarnessV1SandboxProvider = {
    specificationVersion: "harness-sandbox-v1",
    providerId: "identity-probe",
    createSession: async () => session as never,
  };
  const agent = new HarnessAgent({
    harness: harness as never,
    sandbox: provider,
  } as never);
  await expect(agent.createSession()).rejects.toThrow(SENTINEL);
  const match = /^\/home\/user\/(.+)\/\.bootstrap-([0-9a-f]{16})\.ok$/.exec(
    markerPath ?? "",
  );
  if (!match) throw new Error(`unexpected marker path ${markerPath}`);
  return { bootstrapDir: match[1]!, identity: match[2]! };
}

const CLAUDE_AUTH = {
  ANTHROPIC_AUTH_TOKEN: "x",
  ANTHROPIC_BASE_URL: "http://x",
};
const CODEX_AUTH = { CODEX_API_KEY: "x", OPENAI_BASE_URL: "http://x" };
const CURSOR_AUTH = { CURSOR_API_KEY: "x" };

/** The hosted runtimes exactly as `run-harness-turn` builds them. */
function hostedHarnesses(): Record<
  "claude-code" | "codex" | "cursor",
  HarnessWithBootstrap
> {
  const claude = getHarnessAdapter("claude-code")
    .createHarness as unknown as CreateHarness;
  const codex = getHarnessAdapter("codex")
    .createHarness as unknown as CreateHarness;
  const cursor = getHarnessAdapter("cursor")
    .createHarness as unknown as CreateHarness;
  return {
    "claude-code": claude({
      modelId: "anthropic/claude-sonnet-4-5",
      auth: CLAUDE_AUTH,
      mcpJson: { mcpServers: {} },
    }),
    codex: codex({ modelId: "openai/gpt-5.5", auth: CODEX_AUTH }),
    cursor: cursor({ auth: CURSOR_AUTH, mcpJson: { mcpServers: {} } }),
  };
}

/**
 * The same runtimes under every other setting a hosted turn varies: model,
 * MCP servers, reasoning effort, the approval-mode command sandbox. None of
 * them may reach the recipe, or one template could not cover every turn.
 */
function hostedHarnessVariants(): Record<
  "claude-code" | "codex" | "cursor",
  HarnessWithBootstrap[]
> {
  const claude = getHarnessAdapter("claude-code")
    .createHarness as unknown as CreateHarness;
  const codex = getHarnessAdapter("codex")
    .createHarness as unknown as CreateHarness;
  const cursor = getHarnessAdapter("cursor")
    .createHarness as unknown as CreateHarness;
  return {
    "claude-code": [
      claude({
        modelId: "anthropic/claude-haiku-4.5",
        auth: CLAUDE_AUTH,
        reasoningEffort: "high",
        mcpJson: {
          mcpServers: {
            probe: { type: "http", url: "https://example.invalid/mcp" },
          },
        },
      }),
    ],
    codex: [
      codex({
        modelId: "openai/gpt-5.4",
        auth: CODEX_AUTH,
        reasoningEffort: "low",
        sandboxPolicy: HOSTED_APPROVAL_SANDBOX_POLICY,
      }),
    ],
    cursor: [
      cursor({
        auth: { CURSOR_API_KEY: "a-different-key" },
        mcpJson: {
          mcpServers: {
            probe: { type: "http", url: "https://example.invalid/mcp" },
          },
        },
      }),
    ],
  };
}

type HarnessBakeLock = {
  pins: { node: string; pnpm: string };
  recipes: Array<{
    harnessId: string;
    bootstrapDir: string;
    identity: string;
    runtimeVersion: string | null;
  }>;
};

describe("harnessRecipeIdentity", () => {
  it.each(["claude-code", "codex", "cursor"] as const)(
    "is the identity the real framework checks for (%s)",
    async (id) => {
      const harness = hostedHarnesses()[id];
      const recipe = await harness.getBootstrap();
      const seen = await frameworkMarkerIdentity(harness);
      expect(seen.bootstrapDir).toBe(recipe.bootstrapDir);
      expect(harnessRecipeIdentity(recipe)).toBe(seen.identity);
    },
  );

  it("bakes exactly the hosted Claude Code, Codex app-server and Cursor recipes", async () => {
    const harnesses = hostedHarnesses();
    const dirs = await Promise.all(
      Object.values(harnesses).map(
        async (h) => (await h.getBootstrap()).bootstrapDir,
      ),
    );
    expect([...dirs].sort()).toEqual([...HARNESS_BAKED_BOOTSTRAP_DIRS].sort());
  });

  it.each(["claude-code", "codex", "cursor"] as const)(
    "does not depend on the turn's settings (%s)",
    async (id) => {
      const base = harnessRecipeIdentity(
        await hostedHarnesses()[id].getBootstrap(),
      );
      for (const variant of hostedHarnessVariants()[id]) {
        expect(harnessRecipeIdentity(await variant.getBootstrap())).toBe(base);
      }
    },
  );

  it("changes when any byte of the recipe changes", () => {
    const recipe: HarnessBootstrapRecipe = {
      harnessId: "h",
      bootstrapDir: ".harness-bootstrap/h",
      files: [{ path: ".harness-bootstrap/h/a", content: "1" }],
      commands: [{ command: "true" }],
    };
    const base = harnessRecipeIdentity(recipe);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(
      harnessRecipeIdentity({
        ...recipe,
        files: [{ path: ".harness-bootstrap/h/a", content: "2" }],
      }),
    ).not.toBe(base);
    expect(
      harnessRecipeIdentity({ ...recipe, commands: [{ command: "false" }] }),
    ).not.toBe(base);
  });
});

describe("harness-bake.lock.json", () => {
  it("matches the recipes this inspector resolves", async () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as HarnessBakeLock;
    const live: HarnessBakeLock = {
      pins: {
        node: HARNESS_TEMPLATE_NODE_VERSION,
        pnpm: HARNESS_TEMPLATE_PNPM_VERSION,
      },
      recipes: (
        await Promise.all(
          Object.entries(hostedHarnesses()).map(async ([harnessId, h]) => {
            const recipe = await h.getBootstrap();
            return {
              harnessId,
              bootstrapDir: recipe.bootstrapDir,
              identity: harnessRecipeIdentity(recipe),
              runtimeVersion:
                HARNESS_PINNED_VERSIONS[
                  harnessId as keyof typeof HARNESS_PINNED_VERSIONS
                ],
            };
          }),
        )
      ).sort((a, b) => a.bootstrapDir.localeCompare(b.bootstrapDir)),
    };
    const recorded = { pins: lock.pins, recipes: lock.recipes };
    if (JSON.stringify(recorded) !== JSON.stringify(live)) {
      throw new Error(
        "The hosted harness recipes no longer match harness-bake.lock.json, so " +
          "the computer template would not carry the runtimes this inspector " +
          "looks for, and every hosted turn on it would install at turn time.\n" +
          `  lock:  ${JSON.stringify(recorded)}\n` +
          `  live:  ${JSON.stringify(live)}\n` +
          "To fix: run `node scripts/harness-bake-context.mjs --write-lock` from " +
          "mcpjam-inspector/ and commit the lock. Once this merges, rebuild the " +
          "computer template from the merged commit and roll it out: in " +
          "mcpjam-backend, set templates/computer/inspector-bake-ref to that " +
          "commit, build with templates/computer/build.ts, and point " +
          "E2B_TEMPLATE_ID at the new template on staging, then production " +
          "(templates/computer/README.md).",
      );
    }
    expect(recorded).toEqual(live);
  });
});

describe("the toolchain pins", () => {
  it("share node with the toolchain the local packs and conformance run on", () => {
    const toolchain = JSON.parse(
      readFileSync(
        join(PACKAGE_ROOT, "scripts/local-harness-toolchain.json"),
        "utf8",
      ),
    );
    expect(HARNESS_TEMPLATE_NODE_VERSION).toBe(toolchain.node);
  });

  it("pin a pnpm that installs the recipes within a 1 GiB box", () => {
    // pnpm 10 is OOM-killed extracting the native binaries on a 1 GiB box;
    // see HARNESS_TEMPLATE_PNPM_VERSION. Major 12 or later.
    expect(
      Number(HARNESS_TEMPLATE_PNPM_VERSION.split(".")[0]),
    ).toBeGreaterThanOrEqual(12);
  });

  it("pin the providers' pnpm fallback too", () => {
    const installs = harnessPnpmGuardCommand().match(/npm install -g pnpm@[\d.]+/g);
    // Both arms (own rights, then sudo) install the same pinned version.
    expect(installs).toEqual([
      `npm install -g pnpm@${HARNESS_TEMPLATE_PNPM_VERSION}`,
      `npm install -g pnpm@${HARNESS_TEMPLATE_PNPM_VERSION}`,
    ]);
  });

  it("fall back to sudo when npm's global prefix is root's", () => {
    // The desktop template's Node comes from the distro: its global prefix is
    // root-owned and the box runs as `user`, so a plain `npm install -g`
    // exits 243. Own rights first, `sudo -n` (never prompting) otherwise.
    const command = harnessPnpmGuardCommand();
    expect(command.startsWith("command -v pnpm || ")).toBe(true);
    expect(command).toContain(
      '[ -w "$(npm config get prefix)/lib/node_modules" ]',
    );
    expect(command).toContain(
      `else sudo -n npm install -g pnpm@${HARNESS_TEMPLATE_PNPM_VERSION}; fi`,
    );
  });

  it("match the hosted-harness CI test image", () => {
    const dockerfile = readFileSync(
      join(PACKAGE_ROOT, "server/utils/harness/docker/test-image.Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      `node-v${HARNESS_TEMPLATE_NODE_VERSION}-linux-`,
    );
    expect(dockerfile).toContain(`pnpm@${HARNESS_TEMPLATE_PNPM_VERSION}`);
    // Pinned by digest, never a floating tag alone.
    expect(dockerfile).toMatch(/FROM \$\{BASE_IMAGE\}/);
    expect(dockerfile).toMatch(
      /ARG BASE_IMAGE=debian:bookworm-slim@sha256:[0-9a-f]{64}/,
    );
  });
});

describe("the generated bake context", () => {
  let out: string;
  let manifest: {
    bakeId: string;
    bakeRoot: string;
    runtimeUser: string;
    pins: { node: string; pnpm: string };
    harnessPinnedVersions: Record<string, string | null>;
    recipes: Array<{
      harnessId: string;
      bootstrapDir: string;
      dir: string;
      identity: string;
      marker: string;
      runtimeVersion: string;
      files: Array<{ name: string; sha256: string; bytes: number }>;
      bridge: { sha256: string; sentinels: string[] };
    }>;
  };

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "harness-bake-"));
    execFileSync(
      process.execPath,
      ["scripts/harness-bake-context.mjs", "--out", join(out, "ctx")],
      { cwd: PACKAGE_ROOT, stdio: "pipe" },
    );
    manifest = JSON.parse(
      readFileSync(join(out, "ctx", "manifest.json"), "utf8"),
    );
  }, 120_000);

  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it("records the identities the running inspector resolves", async () => {
    // The manifest is what the template bakes; the right hand side is what a
    // hosted turn on this commit will look for.
    const harnesses = hostedHarnesses();
    expect(manifest.recipes).toHaveLength(Object.keys(harnesses).length);
    const byDir = new Map(manifest.recipes.map((r) => [r.bootstrapDir, r]));
    for (const harness of Object.values(harnesses)) {
      const live = await harness.getBootstrap();
      const baked = byDir.get(live.bootstrapDir);
      expect(baked, live.bootstrapDir).toBeDefined();
      expect(baked!.identity).toBe(harnessRecipeIdentity(live));
      expect(baked!.marker).toBe(`.bootstrap-${baked!.identity}.ok`);
      // Byte-identical files, not just a matching hash of them.
      for (const file of live.files) {
        const name = file.path.slice(live.bootstrapDir.length + 1);
        expect(readFileSync(join(out, "ctx", baked!.dir, name), "utf8")).toBe(
          file.content,
        );
      }
      expect(baked!.files.map((f) => f.name).sort()).toEqual(
        live.files
          .map((f) => f.path.slice(live.bootstrapDir.length + 1))
          .sort(),
      );
    }
  });

  it("agrees with the lock the --write-lock flag would write", () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as HarnessBakeLock;
    expect(lock.pins).toEqual(manifest.pins);
    expect(lock.recipes).toEqual(
      manifest.recipes
        .map(({ harnessId, bootstrapDir, identity, runtimeVersion }) => ({
          harnessId,
          bootstrapDir,
          identity,
          runtimeVersion,
        }))
        .sort((a, b) => a.bootstrapDir.localeCompare(b.bootstrapDir)),
    );
  });

  it("records the pins and HARNESS_PINNED_VERSIONS", () => {
    expect(manifest.pins).toEqual({
      node: HARNESS_TEMPLATE_NODE_VERSION,
      pnpm: HARNESS_TEMPLATE_PNPM_VERSION,
    });
    expect(manifest.harnessPinnedVersions).toEqual(HARNESS_PINNED_VERSIONS);
    expect(
      Object.fromEntries(
        manifest.recipes.map((r) => [r.harnessId, r.runtimeVersion]),
      ),
    ).toEqual({
      "claude-code": HARNESS_PINNED_VERSIONS["claude-code"],
      codex: HARNESS_PINNED_VERSIONS.codex,
      cursor: HARNESS_PINNED_VERSIONS.cursor,
    });
    expect(manifest.bakeRoot).toBe("/home/user/.harness-bootstrap");
    expect(manifest.runtimeUser).toBe("user");
  });

  it("checks the Claude Code bridge is the PATCHED one", () => {
    const claude = manifest.recipes.find((r) => r.harnessId === "claude-code")!;
    expect(claude.bridge.sentinels.length).toBeGreaterThan(0);
    const bridge = readFileSync(
      join(out, "ctx", claude.dir, "bridge.mjs"),
      "utf8",
    );
    for (const sentinel of claude.bridge.sentinels) {
      expect(bridge).toContain(sentinel);
    }
  });

  it("is content-addressed: regenerating gives the same bake id", () => {
    execFileSync(
      process.execPath,
      ["scripts/harness-bake-context.mjs", "--out", join(out, "ctx2")],
      { cwd: PACKAGE_ROOT, stdio: "pipe" },
    );
    const again = JSON.parse(
      readFileSync(join(out, "ctx2", "manifest.json"), "utf8"),
    );
    expect(again.bakeId).toBe(manifest.bakeId);
    expect(manifest.bakeId).toMatch(/^[0-9a-f]{12}$/);
  }, 120_000);

  it("refuses to write a context the committed lock does not describe", () => {
    // A template can only be baked from a commit whose lock records what it
    // bakes; the backend's build pins such a commit.
    const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as HarnessBakeLock;
    const stale = join(out, "stale-lock.json");
    writeFileSync(
      stale,
      JSON.stringify({
        ...lock,
        recipes: lock.recipes.map((r) => ({ ...r, identity: "0".repeat(16) })),
      }),
    );
    const run = spawnSync(
      process.execPath,
      [
        "scripts/harness-bake-context.mjs",
        "--out",
        join(out, "refused"),
        "--lock",
        stale,
      ],
      { cwd: PACKAGE_ROOT, encoding: "utf8" },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/do not match .*stale-lock\.json/);
    expect(run.stderr).toMatch(/--write-lock/);
    expect(existsSync(join(out, "refused"))).toBe(false);
  }, 120_000);

  it("refuses to overwrite a directory it did not write", () => {
    const foreign = join(out, "foreign");
    cpSync(join(out, "ctx", "claude-code"), foreign, { recursive: true });
    const run = spawnSync(
      process.execPath,
      ["scripts/harness-bake-context.mjs", "--out", foreign],
      { cwd: PACKAGE_ROOT, encoding: "utf8" },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/refusing to overwrite/);
  });

  it("the in-image bake refuses to run outside the bake root or as the wrong user", () => {
    // The success path needs a real image (the Docker CI job builds one);
    // these are the two refusals that keep a misplaced or root-owned bake from
    // ever writing a marker.
    const misplaced = spawnSync(
      process.execPath,
      [join(out, "ctx", "bake.mjs")],
      {
        encoding: "utf8",
      },
    );
    expect(misplaced.status).toBe(1);
    expect(misplaced.stderr).toMatch(
      /markers are only found at \/home\/user\/\.harness-bootstrap/,
    );

    // Real path: `bake.mjs` locates itself through its module URL, which is
    // resolved (macOS's tmpdir is a symlink into /private).
    const ctx = realpathSync(join(out, "ctx"));
    const relocated = {
      ...manifest,
      bakeRoot: ctx,
      runtimeUser: "no-such-runtime-user",
    };
    writeFileSync(join(ctx, "manifest.json"), JSON.stringify(relocated));
    const wrongUser = spawnSync(process.execPath, [join(ctx, "bake.mjs")], {
      encoding: "utf8",
    });
    expect(wrongUser.status).toBe(1);
    expect(wrongUser.stderr).toMatch(/must run as no-such-runtime-user/);
  });
});
