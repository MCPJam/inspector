import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as recipe from "../../../../../scripts/local-harness-pack-recipes/codex.mjs";
import { CODEX_LOCAL_ADAPTER_IDENTITY } from "../../codex-appserver/local-identity.js";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";

/**
 * The Codex pack recipe (`scripts/local-harness-pack-recipes/codex.mjs`). The
 * full build — bundle, frozen install, every vendor file against its recorded
 * checksum — runs in the conformance workflow; these pin the parts that decide
 * what a published pack is allowed to contain and what it claims to be.
 */
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "codex-recipe-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the Codex pack recipe", () => {
  it("records the identity the compatibility manifest pins", () => {
    expect(recipe.harnessId).toBe("codex");
    expect(recipe.adapterVersion()).toBe(CODEX_LOCAL_ADAPTER_IDENTITY);
    expect(LOCAL_HARNESS_MANIFEST.codex.adapterVersion).toBe(CODEX_LOCAL_ADAPTER_IDENTITY);
  });

  it("fingerprints every source the bridge bundle is built from", () => {
    const sources = recipe.recipeSources;
    for (const expected of [
      "mcpjam-inspector/server/utils/harness/codex-appserver/bridge/index.ts",
      "mcpjam-inspector/server/utils/harness/codex-appserver/bridge/host-tools-mcp.ts",
      "mcpjam-inspector/server/utils/harness/codex-appserver/bridge/mcp-isolation.ts",
      "mcpjam-inspector/server/utils/harness/codex-appserver/shared/sandbox-policy.ts",
      "mcpjam-inspector/server/utils/harness/codex-appserver/bootstrap/pnpm-lock.yaml",
      "mcpjam-inspector/scripts/bundle-codex-appserver-bridge.mjs",
      "mcpjam-inspector/scripts/local-harness-pack-recipes/codex-vendor-checksums.json",
    ]) expect(sources).toContain(expected);
    expect(sources.some((path: string) => path.includes("__tests__"))).toBe(false);
    // The bridge kit and the bundler: a bump to either changes `bridge.mjs`.
    expect(recipe.dependencyRoots).toEqual(["@ai-sdk/harness", "esbuild"]);
  });

  it("bundles the same bridge bytes from any working directory", () => {
    // A local session byte-compares the pack's `bridge.mjs` with the bridge
    // this Inspector carries, and the release check hashes it from the repo
    // root while the npm task bundles from the package. Neither may depend on
    // where the bundler was run from.
    const bundler = fileURLToPath(
      new URL("../../../../../scripts/bundle-codex-appserver-bridge.mjs", import.meta.url),
    );
    const digestFrom = (cwd: string) => execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `const { createHash } = await import("node:crypto");
       const { bundleCodexAppServerBridgeSources } = await import(${JSON.stringify(`file://${bundler}`)});
       const { bridgeSource, hostToolsSource } = await bundleCodexAppServerBridgeSources();
       process.stdout.write(createHash("sha256").update(bridgeSource).update("\\0").update(hostToolsSource).digest("hex"));`,
    ], { cwd, encoding: "utf8" });
    const packageRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
    expect(digestFrom(root)).toBe(digestFrom(packageRoot));
  }, 60_000);

  it("has recorded checksums for every target the manifest could certify", () => {
    const checksums = JSON.parse(readFileSync(
      new URL("../../../../../scripts/local-harness-pack-recipes/codex-vendor-checksums.json", import.meta.url),
      "utf8",
    ));
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]) {
      const files = Object.keys(checksums[target].files);
      expect(files.some((path) => /^vendor\/[^/]+\/bin\/codex(\.exe)?$/.test(path)), target).toBe(true);
      expect(checksums[target].spec).toBe(`@openai/codex@0.149.1-${target}`);
    }
  });

  it("prunes other platforms' packages and refuses anything else in @openai", async () => {
    const scope = join(root, "node_modules", "@openai");
    for (const name of ["codex", "codex-linux-x64", "codex-darwin-arm64"]) {
      await mkdir(join(scope, name), { recursive: true });
    }
    recipe.prunePack(root, "linux-x64");
    expect((await readdir(scope)).sort()).toEqual(["codex", "codex-linux-x64"]);
    await mkdir(join(scope, "something-else"));
    expect(() => recipe.prunePack(root, "linux-x64")).toThrow(/unexpected packages/);
  });

  it("refuses a pack whose wrapper is not the version the checksums were recorded for", async () => {
    const wrapper = join(root, "node_modules", "@openai", "codex");
    await mkdir(join(wrapper, "bin"), { recursive: true });
    await writeFile(join(wrapper, "package.json"), JSON.stringify({ version: "0.150.0" }));
    expect(() => recipe.verifyVendorBinary(root, "linux-x64")).toThrow(/0\.150\.0 is installed/);
  });

  it("refuses a pack built without this target's platform package", async () => {
    const wrapper = join(root, "node_modules", "@openai", "codex");
    await mkdir(join(wrapper, "bin"), { recursive: true });
    await writeFile(join(wrapper, "package.json"), JSON.stringify({ version: "0.149.1" }));
    await writeFile(join(wrapper, "bin", "codex.js"), "");
    expect(() => recipe.verifyVendorBinary(root, "linux-x64")).toThrow(/no @openai\/codex-linux-x64/);
    expect(() => recipe.verifyVendorBinary(root, "solaris-sparc")).toThrow(/no Codex vendor package/);
  });

  it("refuses a platform package whose files differ from the recorded list", async () => {
    const wrapper = join(root, "node_modules", "@openai", "codex");
    await mkdir(join(wrapper, "bin"), { recursive: true });
    await writeFile(join(wrapper, "package.json"), JSON.stringify({ version: "0.149.1" }));
    await writeFile(join(wrapper, "bin", "codex.js"), "");
    const platform = join(root, "node_modules", "@openai", "codex-linux-x64");
    await mkdir(platform, { recursive: true });
    await writeFile(join(platform, "package.json"), "{}");
    await writeFile(join(platform, "extra-binary"), "x");
    expect(() => recipe.verifyVendorBinary(root, "linux-x64")).toThrow(/unexpected: extra-binary/);
  });

  it("reports the vendor packages actually in the pack", async () => {
    for (const [dir, version] of [["@openai/codex", "0.149.1"], ["@openai/codex-linux-x64", "0.149.1-linux-x64"], ["ws", "8.21.0"]]) {
      await mkdir(join(root, "node_modules", dir), { recursive: true });
      await writeFile(join(root, "node_modules", dir, "package.json"), JSON.stringify({ version }));
    }
    expect(recipe.vendorPackages(root)).toEqual({
      "@openai/codex": "0.149.1",
      "@openai/codex-linux-x64": "0.149.1-linux-x64",
      ws: "8.21.0",
    });
  });
});
