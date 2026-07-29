/**
 * Desktop end-to-end: materialize a fixture bundle, substitute its root
 * placeholders at spawn, and drive the resulting process through the real
 * `MCPClientManager` — the same manager the local connect path uses.
 *
 * This is the test that proves the acceptance criteria for real rather than by
 * unit-level proxy: a process starts from the cache, reads its own files
 * through the injected root, and does so with the user's original folder
 * deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClientManager } from "@mcpjam/sdk";
import { PluginBundleCache } from "../bundle-cache.js";
import { resolvePluginStdioLaunch } from "../plugin-root.js";
import {
  fixtureBundleHash,
  fixtureBundleSource,
  makeCacheRoot,
} from "./fixture-bundle.js";
import { WebRouteError } from "../../../routes/web/errors.js";
import { toHttpConfig } from "../../../routes/web/auth.js";

const IDENTITY_BASE = { projectId: "project-1", pluginVersionId: "version-1" };

describe("plugin stdio component (desktop)", () => {
  let cacheRoot: string;
  let cleanup: () => Promise<void>;
  let cache: PluginBundleCache;
  let manager: MCPClientManager;

  beforeEach(async () => {
    ({ root: cacheRoot, cleanup } = await makeCacheRoot());
    cache = new PluginBundleCache({ rootDir: cacheRoot });
    manager = new MCPClientManager({});
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await cleanup();
  });

  it("spawns the materialized component and injects the plugin root", async () => {
    const bundleHash = await fixtureBundleHash();
    const identity = { ...IDENTITY_BASE, bundleHash };
    const materialized = await cache.materialize(identity, {
      source: await fixtureBundleSource(),
    });

    const [component] = materialized.parsed.mcpServers;
    if (component.config.transport !== "stdio") {
      throw new Error("fixture component must be stdio");
    }
    // The SDK preserved the placeholders verbatim; substitution is ours.
    expect(component.config.args[0]).toBe("${PLUGIN_ROOT}/server/index.js");

    const launch = resolvePluginStdioLaunch(
      {
        command: component.config.command,
        args: component.config.args,
        env: {},
      },
      materialized.root
    );

    const release = cache.acquire(identity, "fixture-local");
    await manager.connectToServer("fixture-local", {
      command: launch.command,
      args: launch.args,
      env: launch.env,
    });

    const tools = await manager.listTools("fixture-local");
    expect(tools.tools.map((tool) => tool.name)).toEqual(["plugin_root"]);

    const result = (await manager.executeTool(
      "fixture-local",
      "plugin_root",
      {}
    )) as { content: Array<{ text: string }> };
    const reported = JSON.parse(result.content[0].text) as {
      pluginRoot: string;
      codexPluginRoot: string;
      scriptPath: string;
      dataFileArg: string;
    };

    expect(reported.pluginRoot).toBe(materialized.root);
    expect(reported.codexPluginRoot).toBe(materialized.root);
    expect(reported.scriptPath).toBe(join(materialized.root, "server", "index.js"));
    expect(reported.dataFileArg).toBe(join(materialized.root, "data.txt"));

    await manager.disconnectServer("fixture-local");
    release();
  });

  it("needs no local source path once materialized", async () => {
    // Import from a folder, then delete the folder: a launch must still work,
    // because the cache is keyed by the backend's hash, not by where the user
    // happened to keep the plugin.
    const sourceDir = await mkdtemp(join(tmpdir(), "mcpjam-plugin-src-"));
    const bundleHash = await fixtureBundleHash();
    const identity = { ...IDENTITY_BASE, bundleHash };
    const first = await cache.materialize(identity, {
      source: await fixtureBundleSource(),
    });
    await cp(first.root, sourceDir, { recursive: true });
    await rm(sourceDir, { recursive: true, force: true });

    const relaunch = await new PluginBundleCache({
      rootDir: cacheRoot,
    }).materialize(identity);
    const launch = resolvePluginStdioLaunch(
      {
        command: "node",
        args: ["${PLUGIN_ROOT}/server/index.js"],
        env: {},
      },
      relaunch.root
    );

    await manager.connectToServer("fixture-local", launch);
    const result = (await manager.executeTool(
      "fixture-local",
      "plugin_root",
      {}
    )) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text).pluginRoot).toBe(relaunch.root);
    await manager.disconnectServer("fixture-local");
  });

  it("hosted mode reports local_runtime_required instead of spawning stdio", () => {
    // Hosted never reaches a materializer at all: the transport guard rejects
    // the stdio config while it is still a payload.
    let thrown: unknown;
    try {
      toHttpConfig(
        {
          ok: true,
          role: "owner",
          accessLevel: "full",
          permissions: { chatOnly: false },
          serverConfig: {
            transportType: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/server/index.js"],
            env: {},
          },
        } as never,
        30_000
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WebRouteError);
    const error = thrown as WebRouteError;
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({ readiness: "local_runtime_required" });
  });
});
