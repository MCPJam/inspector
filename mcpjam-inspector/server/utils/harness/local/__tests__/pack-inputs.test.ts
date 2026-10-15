import { appendFileSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import {
  advisorySummary,
  computePackInputs,
  defaultPackInputIo,
  installedClosureDrift,
  movedFingerprints,
  SHARED_PACK_INPUTS,
  withHarnessRecord,
  type PackInputIo,
  type PackInputIoWithInstalls,
} from "../../../../../scripts/check-local-harness-inputs.mjs";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import {
  listPackHarnessIds,
  packRecipeModulePath,
} from "../../../../../scripts/local-harness-pack-harnesses.mjs";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import {
  parsePackTables,
  parseRuntimeCompat,
  renderRuntimeCompat,
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
      "mcpjam-inspector/server/utils/harness/local/tree-digest.ts",
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

describe("refusing to snapshot a tree that is not the locked one", () => {
  type Installed = Awaited<ReturnType<NonNullable<PackInputIo["inspectInstalled"]>>>;

  /** The fake repo above, with an installed tree that defaults to the lock. */
  function installedIo(
    installed: Record<string, Installed> = {},
    scopes: Record<string, string[]> = {},
  ): PackInputIoWithInstalls {
    const base = fakeIo({
      lock: {
        "": { name: "root" },
        "node_modules/alpha-dep": { version: "1.0.0", integrity: "sha512-a" },
        "node_modules/beta-dep": {
          version: "2.0.0",
          integrity: "sha512-b",
          dependencies: { "beta-child": "1" },
          optionalDependencies: { "beta-linux": "1" },
        },
        "node_modules/beta-child": { version: "3.0.0", integrity: "sha512-c" },
        "node_modules/beta-linux": { version: "3.0.0", integrity: "sha512-l", optional: true },
        "node_modules/@ai-sdk/harness-alpha": { version: "1.0.0", integrity: "sha512-h" },
      },
    });
    const lock = {
      "node_modules/alpha-dep": "1.0.0",
      "node_modules/beta-dep": "2.0.0",
      "node_modules/beta-child": "3.0.0",
      "node_modules/@ai-sdk/harness-alpha": "1.0.0",
    } as Record<string, string>;
    return {
      ...base,
      readdir: async (path) => {
        if (path in scopes) return scopes[path]!;
        if (path.endsWith("@ai-sdk")) throw new Error("ENOENT");
        return base.readdir(path);
      },
      inspectInstalled: async (key) =>
        installed[key] ??
        (key in lock ? { kind: "installed", version: lock[key]! } : { kind: "absent" }),
    };
  }

  it("accepts an install that matches the lock, with another platform's optional package absent", async () => {
    expect(await installedClosureDrift(installedIo())).toEqual([]);
  });

  it("refuses a closure package installed at a version the lock does not name (#5823)", async () => {
    const drift = await installedClosureDrift(
      installedIo({ "node_modules/beta-child": { kind: "installed", version: "2.9.0" } }),
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatch(/beta-child is installed at 2\.9\.0 but package-lock\.json has 3\.0\.0/);
  });

  it("refuses a required closure package that is not installed", async () => {
    const drift = await installedClosureDrift(
      installedIo({ "node_modules/alpha-dep": { kind: "absent" } }),
    );
    expect(drift).toEqual([expect.stringMatching(/alpha-dep is not installed/)]);
  });

  it("refuses a linked closure package", async () => {
    const drift = await installedClosureDrift(
      installedIo({ "node_modules/beta-dep": { kind: "linked", target: "/src/beta" } }),
    );
    expect(drift).toEqual([expect.stringMatching(/beta-dep is a symlink \(to \/src\/beta\)/)]);
  });

  it("refuses a linked @ai-sdk/harness* package even outside every closure", async () => {
    const drift = await installedClosureDrift(
      installedIo(
        {
          "mcpjam-inspector/node_modules/@ai-sdk/harness-dev": { kind: "linked", target: "/src/harness" },
        },
        {
          "node_modules/@ai-sdk": ["harness-alpha", "provider"],
          "mcpjam-inspector/node_modules/@ai-sdk": ["harness-dev"],
        },
      ),
    );
    expect(drift).toEqual([
      expect.stringMatching(/mcpjam-inspector\/node_modules\/@ai-sdk\/harness-dev is a symlink/),
    ]);
  });

  it("passes on this checkout's real install", async () => {
    // CI installs with `npm ci`, so the tree is the locked one by construction.
    expect(await installedClosureDrift(defaultPackInputIo)).toEqual([]);
  });
});

describe("the committed fingerprint file", () => {
  const committed = JSON.parse(
    readFileSync(new URL("../pack-inputs.generated.json", import.meta.url), "utf8"),
  );

  it("has one record per harness with a recipe", () => {
    expect(committed.schema).toBe(2);
    expect(Object.keys(committed.harnesses).sort()).toEqual(listPackHarnessIds());
  });

  it("matches the sources, or says which pack the next release will publish", async () => {
    // ADVISORY in CI, like lint.yml's step: a PR that moves a fingerprint is
    // not wrong, it is what the next release publishes — prepare-release
    // builds it and its version PR records the new fingerprint. The release gate is
    // where a stale record blocks. Locally (no job summary) it still fails,
    // so a developer sees which harness their change republishes.
    const moved = movedFingerprints(committed, await computePackInputs(defaultPackInputIo));
    if (moved.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, advisorySummary(moved));
      return;
    }
    expect(moved).toEqual([]);
  });
});

describe("pinning one harness's snapshot", () => {
  const record = (fingerprint: string) => ({ fingerprint, inputs: { a: fingerprint } });

  it("moves exactly the named harness's record and carries the others byte for byte", () => {
    const recorded = { schema: 2, harnesses: { alpha: record("a1"), beta: record("b1") } };
    const computed = { schema: 2 as const, harnesses: { alpha: record("a2"), beta: record("b2") } };
    expect(withHarnessRecord(recorded, computed, "beta")).toEqual({
      schema: 2,
      harnesses: { alpha: record("a1"), beta: record("b2") },
    });
    expect(movedFingerprints(recorded, computed)).toEqual([
      { harnessId: "alpha", recorded: "a1", computed: "a2" },
      { harnessId: "beta", recorded: "b1", computed: "b2" },
    ]);
    expect(() => withHarnessRecord(recorded, computed, "gamma")).toThrow(/no pack recipe/);
  });

  it("summarises moved fingerprints for a job summary, and says nothing when none moved", () => {
    expect(advisorySummary([])).toBe("");
    const text = advisorySummary([
      { harnessId: "codex", recorded: `sha256:${"1".repeat(64)}`, computed: `sha256:${"2".repeat(64)}` },
    ]);
    expect(text).toMatch(/The next release publishes a new runtime pack/);
    expect(text).toMatch(/\*\*codex\*\*/);
    expect(text).toMatch(/prepare-release\.yml/);
  });
});

describe("the runtime compatibility record", () => {
  const source = readFileSync(
    new URL("../runtime-compat.generated.json", import.meta.url),
    "utf8",
  );
  const digest = `sha256:${"b".repeat(64)}`;
  const other = `sha256:${"c".repeat(64)}`;

  it("is a no-op re-render of the committed file", () => {
    // `--check` compares a re-render against the source, so the canonical form
    // and the committed form must be the same bytes.
    expect(renderRuntimeCompat(parseRuntimeCompat(source))).toBe(source);
    const state = parsePackTables(source);
    for (const [harnessId, entry] of Object.entries(state)) {
      expect(
        rewriteHarnessPackTables(source, harnessId, entry.version, entry.digests),
      ).toBe(source);
    }
  });

  it("rewrites the named harness and carries every other one over", () => {
    const withClaude = rewriteHarnessPackTables(source, "claude-code", "9.0.0", {
      "linux-x64": digest,
    });
    const withBoth = rewriteHarnessPackTables(withClaude, "codex", "9.0.0", {
      "darwin-arm64": digest,
    });
    const state = parsePackTables(withBoth);
    expect(state["claude-code"]).toMatchObject({
      version: "9.0.0",
      digests: { "linux-x64": digest },
      records: { "linux-x64": { packVersion: "9.0.0", treeDigest: digest } },
      permitted: {},
    });
    expect(state.codex).toMatchObject({
      version: "9.0.0",
      digests: { "darwin-arm64": digest },
      permitted: {},
    });
    // Republishing Codex leaves the Claude Code entries byte-identical.
    const republished = rewriteHarnessPackTables(withBoth, "codex", "9.0.1", {
      "darwin-arm64": other,
    });
    expect(parsePackTables(republished)["claude-code"]).toEqual(state["claude-code"]);
  });

  it("keeps the replaced pack as the one permitted previous only when asked", () => {
    const first = rewriteHarnessPackTables(source, "codex", "9.0.0", { "linux-x64": digest });
    const without = parsePackTables(
      rewriteHarnessPackTables(first, "codex", "9.0.1", { "linux-x64": other }),
    ).codex;
    expect(without.permitted).toEqual({});

    const promoted = rewriteHarnessPackTables(first, "codex", "9.0.1", { "linux-x64": other }, { permitPrevious: true });
    expect(parsePackTables(promoted).codex.permitted).toEqual({
      "linux-x64": { packVersion: "9.0.0", treeDigest: digest },
    });
    // Idempotent: re-pinning the same desired pack keeps the same previous,
    // even when the flag is passed again — a re-run of the pin never shifts
    // the window.
    expect(
      rewriteHarnessPackTables(promoted, "codex", "9.0.1", { "linux-x64": other }, { permitPrevious: true }),
    ).toBe(promoted);
    // At most ONE previous: the next pin replaces it.
    const third = `sha256:${"d".repeat(64)}`;
    const next = rewriteHarnessPackTables(promoted, "codex", "9.0.2", { "linux-x64": third }, { permitPrevious: true });
    expect(parsePackTables(next).codex.permitted).toEqual({
      "linux-x64": { packVersion: "9.0.1", treeDigest: other },
    });
  });

  it("records the conformance stamp the pin rests on", () => {
    const next = rewriteHarnessPackTables(source, "codex", "9.0.0", { "linux-x64": digest }, {
      conformance: "published-codex-9.0.0-abcdef123456",
      evidence: "https://github.com/MCPJam/inspector/actions/runs/1",
    });
    expect(parsePackTables(next).codex).toMatchObject({
      conformance: "published-codex-9.0.0-abcdef123456",
      evidence: "https://github.com/MCPJam/inspector/actions/runs/1",
    });
  });

  it("refuses a harness the record does not already carry, and a malformed record", () => {
    expect(() =>
      rewriteHarnessPackTables(source, "gemini", "1.0.0", { "linux-x64": digest }),
    ).toThrow(/no gemini entry/);
    const self = JSON.parse(source);
    self.harnesses.codex.targets["linux-x64"].permitted = { ...self.harnesses.codex.targets["linux-x64"].desired };
    expect(() => parseRuntimeCompat(JSON.stringify(self))).toThrow(/permits the desired pack/);
    expect(() => parseRuntimeCompat(JSON.stringify({ schema: 2, harnesses: {} }))).toThrow(/unknown schema/);
  });
});
