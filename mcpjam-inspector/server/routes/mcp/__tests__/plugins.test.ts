import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import pluginsRoute from "../plugins.js";
import {
  PluginBundleCache,
  setPluginBundleCacheForTesting,
} from "../../../services/plugins/local-stdio.js";
import {
  fixtureBundleHash,
  fixtureBundleZip,
  makeCacheRoot,
} from "../../../services/plugins/__tests__/fixture-bundle.js";

const PROJECT_ID = "project-1";
const PLUGIN_VERSION_ID = "version-1";

async function materializeForm(args: {
  bundleHash: string;
  zip?: Uint8Array;
}): Promise<FormData> {
  const form = new FormData();
  form.set("projectId", PROJECT_ID);
  form.set("pluginVersionId", PLUGIN_VERSION_ID);
  form.set("bundleHash", args.bundleHash);
  const zip = args.zip ?? (await fixtureBundleZip());
  form.set(
    "bundle",
    new File([zip as BlobPart], "bundle.zip", { type: "application/zip" })
  );
  return form;
}

describe("POST /api/mcp/plugins/materialize", () => {
  let cacheRoot: string;
  let cleanup: () => Promise<void>;
  let app: Hono;
  let bundleHash: string;

  beforeEach(async () => {
    // No `resetModules` here: the route must share this file's module instance
    // of the plugin service, or the cache seam would not redirect it away from
    // the real `~/.mcpjam`.
    ({ root: cacheRoot, cleanup } = await makeCacheRoot());
    setPluginBundleCacheForTesting(new PluginBundleCache({ rootDir: cacheRoot }));
    bundleHash = await fixtureBundleHash();
    app = new Hono().route("/api/mcp/plugins", pluginsRoute);
  });

  afterEach(async () => {
    setPluginBundleCacheForTesting(null);
    await cleanup();
  });

  it("seeds the cache from an imported bundle archive", async () => {
    const response = await app.request("/api/mcp/plugins/materialize", {
      method: "POST",
      body: await materializeForm({ bundleHash }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      bundleHash,
      componentCount: 1,
    });
  });

  it("rejects an archive that does not match the pinned hash", async () => {
    const response = await app.request("/api/mcp/plugins/materialize", {
      method: "POST",
      body: await materializeForm({ bundleHash: "a".repeat(64) }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      reason: "hash_mismatch",
    });
  });

  it("requires the plugin identity fields", async () => {
    const form = new FormData();
    form.set("projectId", PROJECT_ID);
    const response = await app.request("/api/mcp/plugins/materialize", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(400);
  });

  it("collects only unreferenced entries", async () => {
    await app.request("/api/mcp/plugins/materialize", {
      method: "POST",
      body: await materializeForm({ bundleHash }),
    });

    const keep = await app.request("/api/mcp/plugins/gc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepBundleHashes: [bundleHash] }),
    });
    await expect(keep.json()).resolves.toEqual({
      success: true,
      removedCount: 0,
    });

    const drop = await app.request("/api/mcp/plugins/gc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepBundleHashes: [] }),
    });
    await expect(drop.json()).resolves.toEqual({
      success: true,
      removedCount: 1,
    });
  });
});

describe("hosted mode", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../../../config.js");
  });

  it("reports local_runtime_required instead of materializing", async () => {
    vi.resetModules();
    vi.doMock("../../../config.js", async () => {
      const actual =
        await vi.importActual<typeof import("../../../config.js")>(
          "../../../config.js"
        );
      return { ...actual, HOSTED_MODE: true };
    });
    const plugins = (await import("../plugins.js")).default;
    const app = new Hono().route("/api/mcp/plugins", plugins);

    const response = await app.request("/api/mcp/plugins/materialize", {
      method: "POST",
      body: await materializeForm({ bundleHash: "a".repeat(64) }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      readiness: "local_runtime_required",
    });
  });
});
