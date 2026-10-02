import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import {
  computeHarnessPackInputs,
  computePackInputs,
  defaultPackInputIo,
  SHARED_PACK_INPUTS,
  type PackInputIo,
} from "../../../../../scripts/check-local-harness-inputs.mjs";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import {
  listPackHarnessIds,
  packRecipeModulePath,
} from "../../../../../scripts/local-harness-pack-harnesses.mjs";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import {
  parsePackTables,
  rewriteHarnessPackTables,
} from "../../../../../scripts/local-harness-pack-tables.mjs";

/**
 * Per-harness pack fingerprints, and the isolation they exist to provide.
 *
 * The property under test is not "there are two records". It is that each
 * record moves exactly when its pack's bytes could: a Codex-only edit leaves
 * Claude Code's fingerprint byte-identical, a change to the shared build
 * machinery moves both, and a change to either recipe's EMITTED bytes moves
 * that recipe's pack. Splitting one fingerprint into two while both still
 * hashed one monolithic build script would pass a shape test and fail this.
 */

const ALPHA_SOURCE = "mcpjam-inspector/fake/alpha-bootstrap.ts";
const BETA_SOURCE = "mcpjam-inspector/fake/beta-bootstrap.ts";

/** Two fake harnesses over an in-memory repo, sharing the real shared paths. */
function fakeIo(overrides: {
  files?: Record<string, string>;
  recipes?: Record<string, Record<string, string>>;
  lock?: Record<string, unknown>;
} = {}): PackInputIo {
  const files: Record<string, string> = {
    [packRecipeModulePath("alpha")]: "alpha recipe module",
    [packRecipeModulePath("beta")]: "beta recipe module",
    [ALPHA_SOURCE]: "alpha source",
    [BETA_SOURCE]: "beta source",
    ...Object.fromEntries(SHARED_PACK_INPUTS.map((path) => [path, `shared ${path}`])),
    "mcpjam-inspector/tools/mcpjam-job-launcher/main.go": "package main",
    ...overrides.files,
  };
  const recipes: Record<string, Record<string, string>> = {
    alpha: { "bridge.mjs": "alpha bridge", "package.json": "{}" },
    beta: { "bridge.mjs": "beta bridge", "package.json": "{}" },
    ...overrides.recipes,
  };
  const lock = overrides.lock ?? {
    "": { name: "root" },
    "node_modules/alpha-dep": { version: "1.0.0", integrity: "sha512-a" },
    "node_modules/beta-dep": { version: "2.0.0", integrity: "sha512-b", dependencies: { "beta-child": "1" } },
    "node_modules/beta-child": { version: "3.0.0", integrity: "sha512-c" },
  };
  return {
    readFile: async (path) => {
      if (!(path in files)) throw new Error(`fake repo has no ${path}`);
      return files[path]!;
    },
    readdir: async () => ["main.go", "README.md"],
    readLockPackages: async () => lock,
    listHarnesses: async () => ["alpha", "beta"],
    loadHarness: async (harnessId) => ({
      recipeSources: [harnessId === "alpha" ? ALPHA_SOURCE : BETA_SOURCE],
      dependencyRoots: [harnessId === "alpha" ? "alpha-dep" : "beta-dep"],
      loadRecipe: async () => ({
        bootstrapDir: `.harness-bootstrap/${harnessId}`,
        files: Object.entries(recipes[harnessId]!).map(([name, content]) => ({
          path: `.harness-bootstrap/${harnessId}/${name}`,
          content,
        })),
      }),
    }),
  };
}

async function fingerprints(io: PackInputIo) {
  const { harnesses } = await computePackInputs(io);
  return {
    alpha: harnesses.alpha!.fingerprint,
    beta: harnesses.beta!.fingerprint,
  };
}

describe("per-harness pack fingerprints", () => {
  it("leaves one harness's fingerprint unchanged by a change only another harness reads", async () => {
    const before = await fingerprints(fakeIo());

    // The other harness's recipe module…
    const recipeModule = await fingerprints(
      fakeIo({ files: { [packRecipeModulePath("beta")]: "beta recipe module v2" } }),
    );
    expect(recipeModule.alpha).toBe(before.alpha);
    expect(recipeModule.beta).not.toBe(before.beta);

    // …the sources its recipe declares…
    const source = await fingerprints(fakeIo({ files: { [BETA_SOURCE]: "beta source v2" } }));
    expect(source.alpha).toBe(before.alpha);
    expect(source.beta).not.toBe(before.beta);

    // …and its dependency closure, transitively.
    const lock = await fingerprints(
      fakeIo({
        lock: {
          "": { name: "root" },
          "node_modules/alpha-dep": { version: "1.0.0", integrity: "sha512-a" },
          "node_modules/beta-dep": { version: "2.0.0", integrity: "sha512-b", dependencies: { "beta-child": "1" } },
          "node_modules/beta-child": { version: "3.0.1", integrity: "sha512-c2" },
          // An unrelated Inspector dependency is in neither closure.
          "node_modules/unrelated": { version: "9.9.9", integrity: "sha512-z" },
        },
      }),
    );
    expect(lock.alpha).toBe(before.alpha);
    expect(lock.beta).not.toBe(before.beta);
  });

  it("invalidates every harness on a change to the shared build machinery", async () => {
    const before = await fingerprints(fakeIo());
    for (const shared of [
      "mcpjam-inspector/server/utils/harness/local/pack/launcher.mjs",
      "mcpjam-inspector/server/utils/harness/local/runtime-identity.ts",
      "mcpjam-inspector/scripts/local-harness-toolchain.json",
      "mcpjam-inspector/scripts/build-local-harness-pack.mjs",
      ".github/workflows/local-harness-pack.yml",
      "mcpjam-inspector/tools/mcpjam-job-launcher/main.go",
    ]) {
      const after = await fingerprints(fakeIo({ files: { [shared]: "changed" } }));
      expect(after.alpha, shared).not.toBe(before.alpha);
      expect(after.beta, shared).not.toBe(before.beta);
    }
  });

  it("invalidates exactly the pack whose emitted recipe bytes change", async () => {
    const before = await fingerprints(fakeIo());
    const alphaBridge = await fingerprints(
      fakeIo({
        recipes: { alpha: { "bridge.mjs": "alpha bridge v2", "package.json": "{}" } },
      }),
    );
    expect(alphaBridge.alpha).not.toBe(before.alpha);
    expect(alphaBridge.beta).toBe(before.beta);

    // A recipe gaining a file (a committed lockfile, say) is a change too.
    const betaLockfile = await fingerprints(
      fakeIo({
        recipes: {
          beta: { "bridge.mjs": "beta bridge", "package.json": "{}", "pnpm-lock.yaml": "lock" },
        },
      }),
    );
    expect(betaLockfile.alpha).toBe(before.alpha);
    expect(betaLockfile.beta).not.toBe(before.beta);
  });
});

describe("the committed fingerprint file", () => {
  it("has one record per harness with a recipe, and matches the sources", async () => {
    const committed = JSON.parse(
      readFileSync(
        new URL("../pack-inputs.generated.json", import.meta.url),
        "utf8",
      ),
    );
    expect(committed.schema).toBe(2);
    expect(Object.keys(committed.harnesses).sort()).toEqual(listPackHarnessIds());
    // The same check CI runs: a stale record here is a pack nobody reviewed.
    expect(await computePackInputs(defaultPackInputIo)).toEqual(committed);
  });
});

describe("rewriting one harness's digest entries", () => {
  const source = readFileSync(
    new URL("../pack-digests.generated.ts", import.meta.url),
    "utf8",
  );
  const digest = `sha256:${"b".repeat(64)}`;

  it("is a no-op re-render of the committed file", () => {
    // `--check` compares a re-render against the source, so the canonical form
    // and the committed form must be the same bytes.
    const state = parsePackTables(source);
    for (const [harnessId, entry] of Object.entries(state)) {
      expect(
        rewriteHarnessPackTables(source, harnessId, entry.version, entry.digests),
      ).toBe(source);
    }
  });

  it("rewrites the named harness and carries every other one over", () => {
    const withClaude = rewriteHarnessPackTables(source, "claude-code", "1.0.0", {
      "linux-x64": digest,
    });
    const withBoth = rewriteHarnessPackTables(withClaude, "codex", "1.0.0", {
      "darwin-arm64": digest,
    });
    const state = parsePackTables(withBoth);
    expect(state["claude-code"]).toEqual({
      version: "1.0.0",
      digests: { "linux-x64": digest },
      records: { "linux-x64": { packVersion: "1.0.0", treeDigest: digest } },
    });
    expect(state.codex).toEqual({
      version: "1.0.0",
      digests: { "darwin-arm64": digest },
      records: { "darwin-arm64": { packVersion: "1.0.0", treeDigest: digest } },
    });
    // Republishing Codex leaves the Claude Code entries byte-identical.
    const republished = rewriteHarnessPackTables(withBoth, "codex", "1.0.1", {
      "darwin-arm64": `sha256:${"c".repeat(64)}`,
    });
    expect(parsePackTables(republished)["claude-code"]).toEqual(state["claude-code"]);
  });

  it("refuses a harness the tables do not already carry", () => {
    expect(() =>
      rewriteHarnessPackTables(source, "gemini", "1.0.0", { "linux-x64": digest }),
    ).toThrow(/no gemini entry/);
  });
});
