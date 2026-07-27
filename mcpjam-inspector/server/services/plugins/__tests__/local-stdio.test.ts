import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { PluginBundleCache } from "../bundle-cache.js";
import {
  materializePluginStdioForConnect,
  preparePluginStdioLaunch,
  releasePluginLease,
  resolvePluginOriginForServer,
} from "../local-stdio.js";
import {
  fixtureBundleHash,
  fixtureBundleSource,
  makeCacheRoot,
} from "./fixture-bundle.js";
import { WebRouteError } from "../../../routes/web/errors.js";

const PROJECT_ID = "project-1";
const PLUGIN_ID = "plugin-1";
const VERSION_ID = "version-1";
const SERVER_ID = "server-1";

/**
 * Minimal Convex stub answering the two reads the materializer performs.
 * `enabled`/`available` are knobs so the tests can reproduce a plugin that was
 * disabled or uninstalled between launches — the case that must fail closed.
 */
function stubClient(options?: {
  enabled?: boolean;
  available?: boolean;
  bundleHash?: string | null;
}): ConvexHttpClient {
  const enabled = options?.enabled ?? true;
  const available = options?.available ?? true;
  const bundleHash =
    options?.bundleHash === undefined ? "hash-pending" : options.bundleHash;
  return {
    async query(name: string) {
      if (name === "plugins:listProjectPlugins") {
        return [
          {
            pluginId: PLUGIN_ID,
            name: "fixture-plugin",
            enabled,
            activeVersionId: VERSION_ID,
          },
        ];
      }
      if (name === "plugins:resolvePluginRuntimePreview") {
        if (!available) return { pluginVersions: [], effectiveServerIds: [] };
        return {
          pluginVersions: [
            {
              pluginVersionId: VERSION_ID,
              pluginId: PLUGIN_ID,
              name: "fixture-plugin",
              ...(bundleHash === null ? {} : { bundleHash }),
            },
          ],
          effectiveServerIds: [SERVER_ID],
          pluginSkills: [],
        };
      }
      throw new Error(`unexpected query: ${name}`);
    },
  } as unknown as ConvexHttpClient;
}

const PLACEHOLDER_SPEC = {
  command: "node",
  args: ["${PLUGIN_ROOT}/server/index.js"],
  env: {},
};

describe("plugin stdio origin resolution", () => {
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
    releasePluginLease(SERVER_ID);
    await cleanup();
  });

  it("attributes a server to its pinned plugin version", async () => {
    await expect(
      resolvePluginOriginForServer(stubClient({ bundleHash }), {
        projectId: PROJECT_ID,
        serverId: SERVER_ID,
      })
    ).resolves.toEqual({
      pluginId: PLUGIN_ID,
      pluginVersionId: VERSION_ID,
      name: "fixture-plugin",
      bundleHash,
    });
  });

  it.each([
    ["disabled plugin", { enabled: false }],
    ["uninstalled / unavailable version", { available: false }],
  ])("returns no origin for a %s", async (_label, options) => {
    await expect(
      resolvePluginOriginForServer(stubClient(options), {
        projectId: PROJECT_ID,
        serverId: SERVER_ID,
      })
    ).resolves.toBeNull();
  });

  it("prepares a launch and leases the cache entry", async () => {
    await cache.materialize(
      { projectId: PROJECT_ID, pluginVersionId: VERSION_ID, bundleHash },
      { source: await fixtureBundleSource() }
    );

    const prepared = await preparePluginStdioLaunch({
      client: stubClient({ bundleHash }),
      cache,
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      spec: PLACEHOLDER_SPEC,
      leaseId: SERVER_ID,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.launch.args[0]).toBe(`${prepared.pluginRoot}/server/index.js`);
    expect(prepared.launch.env.PLUGIN_ROOT).toBe(prepared.pluginRoot);
    expect(cache.activeEntries()).toEqual([prepared.pluginRoot]);

    prepared.release();
    expect(cache.activeEntries()).toEqual([]);
  });

  it.each([
    [
      "a plugin that no longer resolves",
      () => stubClient({ enabled: false }),
      "no_plugin_origin",
    ],
    [
      "a version without a bundle hash",
      () => stubClient({ bundleHash: null }),
      "missing_bundle_hash",
    ],
  ])("fails closed for %s", async (_label, client, reason) => {
    const prepared = await preparePluginStdioLaunch({
      client: client(),
      cache,
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      spec: PLACEHOLDER_SPEC,
      leaseId: SERVER_ID,
    });
    expect(prepared).toMatchObject({ ok: false, reason });
  });

  it("reports an un-materialized bundle rather than spawning a placeholder", async () => {
    const prepared = await preparePluginStdioLaunch({
      client: stubClient({ bundleHash }),
      cache,
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      spec: PLACEHOLDER_SPEC,
      leaseId: SERVER_ID,
    });
    expect(prepared).toMatchObject({
      ok: false,
      reason: "bundle_not_materialized",
    });
  });
});

describe("materializePluginStdioForConnect", () => {
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
    releasePluginLease(SERVER_ID);
    await cleanup();
  });

  it("leaves an ordinary stdio server completely alone", async () => {
    await expect(
      materializePluginStdioForConnect({
        // A non-plugin server must not cost a single Convex read.
        createClient: () => {
          throw new Error("must not query for a non-plugin server");
        },
        projectId: PROJECT_ID,
        serverId: SERVER_ID,
        serverName: SERVER_ID,
        spec: { command: "node", args: ["server.js"], env: {} },
        cache,
      })
    ).resolves.toBeNull();
  });

  it("substitutes the root for a plugin component", async () => {
    await cache.materialize(
      { projectId: PROJECT_ID, pluginVersionId: VERSION_ID, bundleHash },
      { source: await fixtureBundleSource() }
    );

    const result = await materializePluginStdioForConnect({
      createClient: () => stubClient({ bundleHash }),
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      serverName: SERVER_ID,
      spec: PLACEHOLDER_SPEC,
      cache,
    });

    expect(result?.args[0]).toBe(`${result?.pluginRoot}/server/index.js`);
    expect(result?.env.CODEX_PLUGIN_ROOT).toBe(result?.pluginRoot);
    expect(cache.activeEntries()).toEqual([result?.pluginRoot]);

    // Re-connecting the same server replaces its lease instead of stacking one.
    await materializePluginStdioForConnect({
      createClient: () => stubClient({ bundleHash }),
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      serverName: SERVER_ID,
      spec: PLACEHOLDER_SPEC,
      cache,
    });
    expect(cache.activeEntries()).toEqual([result?.pluginRoot]);
    releasePluginLease(SERVER_ID);
    expect(cache.activeEntries()).toEqual([]);
  });

  it("throws an actionable 409 when the cached bundle was tampered with", async () => {
    const { root } = await cache.materialize(
      { projectId: PROJECT_ID, pluginVersionId: VERSION_ID, bundleHash },
      { source: await fixtureBundleSource() }
    );
    await appendFile(join(root, "data.txt"), "tampered");

    const error = await materializePluginStdioForConnect({
      createClient: () => stubClient({ bundleHash }),
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      serverName: SERVER_ID,
      spec: PLACEHOLDER_SPEC,
      cache,
    }).catch((err) => err);

    expect(error).toBeInstanceOf(WebRouteError);
    expect((error as WebRouteError).status).toBe(409);
    expect((error as WebRouteError).details).toMatchObject({
      reason: "bundle_verification_failed",
    });
    // Nothing was leased for a launch that never happened.
    expect(cache.activeEntries()).toEqual([]);
  });
});
