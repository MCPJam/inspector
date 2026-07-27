/**
 * Local-runtime plugin bundle endpoints (INS-6).
 *
 * `POST /materialize` seeds the verified content cache from the archive a
 * desktop import just produced (the same ZIP `folderSelectionToPluginZip`
 * uploads to Convex), and `POST /gc` reclaims entries no live session is using.
 *
 * WHY A SEED ENDPOINT AT ALL: the backend stores every ready bundle
 * (`pluginVersions.bundleStorageId`) but exposes no authorized read for its
 * bytes today — `getPluginVersion` returns metadata only, and there is no
 * plugin HTTP route. Until such an endpoint exists, the one honest source of
 * content on a desktop machine is the import the user just performed, so the
 * cache is filled from it. Nothing here trusts that content: the caller states
 * the backend-pinned `bundleHash`, and the cache refuses anything that does not
 * hash to it. The local absolute folder path is used for the upload only and is
 * never persisted — the cache is keyed by hash.
 *
 * These routes are local-runtime only; hosted mode has no local process and
 * refuses.
 */
import { Hono } from "hono";
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  PluginBundleCacheError,
  getPluginBundleCache,
} from "../../services/plugins/local-stdio.js";
import { createZipPluginFileSource } from "../../services/plugins/bundle-file-sources.js";
import { MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES } from "../../../shared/plugin-bundle-limits.js";

const plugins = new Hono();

plugins.use("*", async (c, next) => {
  if (HOSTED_MODE) {
    return c.json(
      {
        success: false,
        error:
          "Plugin bundles are materialized by the local runtime; hosted mode cannot spawn local processes.",
        readiness: "local_runtime_required",
      },
      400
    );
  }
  await next();
});

plugins.post("/materialize", async (c) => {
  const body = await c.req.parseBody();
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const pluginVersionId =
    typeof body.pluginVersionId === "string" ? body.pluginVersionId : "";
  const bundleHash = typeof body.bundleHash === "string" ? body.bundleHash : "";
  const file = body.bundle;

  if (!projectId || !pluginVersionId || !bundleHash) {
    return c.json(
      {
        success: false,
        error: "projectId, pluginVersionId and bundleHash are required",
      },
      400
    );
  }
  if (!(file instanceof File)) {
    return c.json(
      { success: false, error: "bundle (a plugin ZIP) is required" },
      400
    );
  }
  if (file.size > MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES) {
    return c.json(
      {
        success: false,
        error: `Bundle archive is larger than ${MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES} bytes`,
      },
      413
    );
  }

  try {
    const source = await createZipPluginFileSource(
      new Uint8Array(await file.arrayBuffer())
    );
    const materialized = await getPluginBundleCache().materialize(
      { projectId, pluginVersionId, bundleHash },
      { source }
    );
    return c.json({
      success: true,
      bundleHash: materialized.bundleHash,
      // The cache path is inspector-internal, not something the client stores:
      // it is re-derived from (project, plugin, hash) on every launch.
      componentCount: materialized.parsed.mcpServers.length,
    });
  } catch (error) {
    if (error instanceof PluginBundleCacheError) {
      // 409: well-formed request, content the caller must fix (wrong archive,
      // tampered files) — retrying it verbatim cannot succeed.
      return c.json(
        { success: false, error: error.message, reason: error.code },
        409
      );
    }
    logger.error("Failed to materialize plugin bundle", error, {
      pluginVersionId,
    });
    return c.json(
      { success: false, error: "Failed to materialize plugin bundle" },
      500
    );
  }
});

plugins.post("/gc", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const keepBundleHashes = Array.isArray(
    (body as { keepBundleHashes?: unknown }).keepBundleHashes
  )
    ? ((body as { keepBundleHashes: unknown[] }).keepBundleHashes.filter(
        (value): value is string => typeof value === "string"
      ) as string[])
    : [];
  try {
    const { removed } = await getPluginBundleCache().collectGarbage({
      keepBundleHashes,
    });
    return c.json({ success: true, removedCount: removed.length });
  } catch (error) {
    logger.error("Failed to collect plugin bundle cache garbage", error);
    return c.json(
      { success: false, error: "Failed to clean the plugin bundle cache" },
      500
    );
  }
});

export default plugins;
