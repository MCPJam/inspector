import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PluginBundleCache,
  PluginBundleCacheError,
} from "../bundle-cache.js";
import {
  fixtureBundleFiles,
  fixtureBundleHash,
  fixtureBundleSource,
  makeCacheRoot,
} from "./fixture-bundle.js";

const PROJECT_ID = "project-1";
const PLUGIN_VERSION_ID = "version-1";

describe("PluginBundleCache", () => {
  let cacheRoot: string;
  let cleanup: () => Promise<void>;
  let cache: PluginBundleCache;
  let bundleHash: string;

  beforeEach(async () => {
    ({ root: cacheRoot, cleanup } = await makeCacheRoot());
    cache = new PluginBundleCache({ rootDir: cacheRoot });
    bundleHash = await fixtureBundleHash();
  });

  afterEach(async () => {
    await cleanup();
  });

  const identity = () => ({
    projectId: PROJECT_ID,
    pluginVersionId: PLUGIN_VERSION_ID,
    bundleHash,
  });

  it("extracts a bundle into a content-addressed entry", async () => {
    const result = await cache.materialize(identity(), {
      source: await fixtureBundleSource(),
    });

    expect(result.root).toBe(join(cacheRoot, PROJECT_ID, PLUGIN_VERSION_ID, bundleHash));
    expect(result.bundleHash).toBe(bundleHash);
    expect(result.parsed.mcpServers).toHaveLength(1);
    await expect(
      readFile(join(result.root, "server", "index.js"), "utf8")
    ).resolves.toContain("tools/call");
    // Extraction is files only — no install script ever runs, so nothing the
    // bundle could declare appears in the entry beyond its own content.
    const entries = await readdir(result.root);
    expect(entries.sort()).toEqual([".codex-plugin", ".mcp.json", "data.txt", "server"]);
  });

  it("serves a cache hit with no source at all", async () => {
    await cache.materialize(identity(), { source: await fixtureBundleSource() });

    // The acceptance criterion: after materialization nothing needs the user's
    // original folder — a fresh cache object with only backend identity works.
    const reopened = new PluginBundleCache({ rootDir: cacheRoot });
    const result = await reopened.materialize(identity());
    expect(result.root).toBe(join(cacheRoot, PROJECT_ID, PLUGIN_VERSION_ID, bundleHash));
  });

  it("rejects content that does not hash to the pinned bundleHash", async () => {
    const wrongPin = { ...identity(), bundleHash: "f".repeat(64) };
    await expect(
      cache.materialize(wrongPin, { source: await fixtureBundleSource() })
    ).rejects.toMatchObject({ code: "hash_mismatch" });

    // Nothing was written at all — the mismatch is caught before extraction,
    // so not even a temp directory exists under the plugin path.
    await expect(
      readdir(join(cacheRoot, PROJECT_ID, PLUGIN_VERSION_ID))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [
      "edited file",
      async (root: string) => appendFile(join(root, "data.txt"), "tampered"),
    ],
    [
      "added file",
      async (root: string) => writeFile(join(root, "extra.txt"), "evil"),
    ],
    ["deleted file", async (root: string) => rm(join(root, "data.txt"))],
  ])("fails verification for a tampered cache entry (%s)", async (_label, tamper) => {
    const { root } = await cache.materialize(identity(), {
      source: await fixtureBundleSource(),
    });
    await tamper(root);

    const error = await cache.materialize(identity()).catch((err) => err);
    expect(error).toBeInstanceOf(PluginBundleCacheError);
    expect(["hash_mismatch", "invalid_bundle"]).toContain(error.code);
  });

  it("re-materializes over a tampered entry when a source is available", async () => {
    const { root } = await cache.materialize(identity(), {
      source: await fixtureBundleSource(),
    });
    await appendFile(join(root, "data.txt"), "tampered");

    const repaired = await cache.materialize(identity(), {
      source: await fixtureBundleSource(),
    });
    await expect(readFile(join(repaired.root, "data.txt"), "utf8")).resolves.toBe(
      fixtureBundleFiles()["data.txt"]
    );
  });

  it("reports not_cached instead of guessing when nothing is materialized", async () => {
    await expect(cache.materialize(identity())).rejects.toMatchObject({
      code: "not_cached",
    });
  });

  it("refuses to build a cache path from an unsafe identity", async () => {
    await expect(
      cache.materialize({ ...identity(), pluginVersionId: "../escape" })
    ).rejects.toMatchObject({ code: "invalid_bundle" });
  });

  describe("garbage collection", () => {
    it("removes unreferenced entries and leftover temp directories", async () => {
      const { root } = await cache.materialize(identity(), {
        source: await fixtureBundleSource(),
      });
      const staleTemp = join(
        cacheRoot,
        PROJECT_ID,
        PLUGIN_VERSION_ID,
        ".mcpjam-tmp-crashed"
      );
      await mkdir(staleTemp, { recursive: true });

      const { removed } = await cache.collectGarbage();
      expect(removed).toContain(root);
      expect(removed).toContain(staleTemp);
      await expect(
        readdir(join(cacheRoot, PROJECT_ID, PLUGIN_VERSION_ID))
      ).resolves.toEqual([]);
    });

    it("keeps entries a live session leased", async () => {
      const { root } = await cache.materialize(identity(), {
        source: await fixtureBundleSource(),
      });
      const release = cache.acquire(identity(), "fixture-local");

      expect((await cache.collectGarbage()).removed).not.toContain(root);
      expect(cache.activeEntries()).toEqual([root]);

      release();
      expect((await cache.collectGarbage()).removed).toContain(root);
    });

    it("keeps entries whose bundle hash is still pinned", async () => {
      const { root } = await cache.materialize(identity(), {
        source: await fixtureBundleSource(),
      });
      expect(
        (await cache.collectGarbage({ keepBundleHashes: [bundleHash] })).removed
      ).not.toContain(root);
    });
  });
});
