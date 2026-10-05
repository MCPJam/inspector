import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
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
import { HARNESS_PINNED_VERSIONS } from "@/shared/harness-model-support";

// The bake only works if the identity the TEMPLATE baked is the identity the
// RUNNING inspector resolves. Two ways that breaks, both silent in production
// (every box quietly falls back to installing): the framework changes how it
// hashes a recipe, or a recipe changes without a new bake. This file pins
// both, against the real framework and the real recipe builders — nothing
// here is a recorded identity, so a recipe change never needs this file
// edited, only a new template.

const PACKAGE_ROOT = resolve(__dirname, "../../../..");
const SENTINEL = "stop-after-marker-read";

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

/** The hosted runtimes exactly as `run-harness-turn` builds them. */
function hostedHarnesses() {
  vi.stubEnv("MCPJAM_CODEX_APPSERVER_TRANSPORT", "true");
  const auth = { ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_BASE_URL: "http://x" };
  const claude = getHarnessAdapter("claude-code");
  const codex = getHarnessAdapter("codex");
  vi.unstubAllEnvs();
  return {
    "claude-code": (claude.createHarness as (args: unknown) => unknown)({
      modelId: "anthropic/claude-sonnet-4-5",
      auth,
      mcpJson: { mcpServers: {} },
    }),
    codex: (codex.createHarness as (args: unknown) => unknown)({
      modelId: "openai/gpt-5.5",
      auth: { CODEX_API_KEY: "x", OPENAI_BASE_URL: "http://x" },
    }),
  } as Record<string, { getBootstrap: () => Promise<HarnessBootstrapRecipe> }>;
}

describe("harnessRecipeIdentity", () => {
  it.each(["claude-code", "codex"] as const)(
    "is the identity the real framework checks for (%s)",
    async (id) => {
      const harness = hostedHarnesses()[id]!;
      const recipe = await harness.getBootstrap();
      const seen = await frameworkMarkerIdentity(harness);
      expect(seen.bootstrapDir).toBe(recipe.bootstrapDir);
      expect(harnessRecipeIdentity(recipe)).toBe(seen.identity);
    },
  );

  it("bakes exactly the hosted Claude Code and Codex app-server recipes", async () => {
    const harnesses = hostedHarnesses();
    const dirs = await Promise.all(
      Object.values(harnesses).map(
        async (h) => (await h.getBootstrap()).bootstrapDir,
      ),
    );
    expect([...dirs].sort()).toEqual([...HARNESS_BAKED_BOOTSTRAP_DIRS].sort());
  });

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

describe("the toolchain pins", () => {
  it("are the toolchain the local packs and conformance run on", () => {
    const toolchain = JSON.parse(
      readFileSync(
        join(PACKAGE_ROOT, "scripts/local-harness-toolchain.json"),
        "utf8",
      ),
    );
    expect(HARNESS_TEMPLATE_NODE_VERSION).toBe(toolchain.node);
    expect(HARNESS_TEMPLATE_PNPM_VERSION).toBe(toolchain.pnpm);
  });

  it("pin the providers' pnpm fallback too", () => {
    expect(harnessPnpmGuardCommand()).toBe(
      `command -v pnpm || npm install -g pnpm@${HARNESS_TEMPLATE_PNPM_VERSION}`,
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
    // THE drift check. The manifest is what the template bakes; the right
    // hand side is what a hosted turn on this commit will look for.
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

    const ctx = join(out, "ctx");
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
