/**
 * Pushing a plugin bundle into a hosted box: a bundle with many executables,
 * and two servers of one plugin starting together. As in
 * `computer-stdio.test.ts`, only the sandbox and the `/plugin-runtime/*`
 * routes are faked; the bundle cache and the push are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { PluginBundleCache } from "../bundle-cache.js";
import {
  ensurePluginStdioRuntime,
  type PluginBoxHandle,
  type PluginRuntimeBox,
} from "../computer-stdio.js";
import {
  fixtureBundleFiles,
  fixtureBundleHash,
  fixtureBundleSource,
  makeCacheRoot,
} from "./fixture-bundle.js";

const PROJECT_ID = "project-1";
const PLUGIN_ID = "plugin-1";
const VERSION_ID = "version-1";
const SANDBOX_ID = "sbx-abc";

const BOX: PluginRuntimeBox = {
  kind: "computer",
  computerId: "computer-1",
  sandboxId: SANDBOX_ID,
};

const SPEC = {
  command: "node",
  args: ["${PLUGIN_ROOT}/server/index.js"],
  env: {},
};

/** Enough executables for three `chmod` batches. */
const TOOLS = Array.from(
  { length: 250 },
  (_, index) => `bin/tool-${String(index).padStart(3, "0")}`,
);

/** The backend's answers for one plugin version providing `serverIds`. */
function stubClient(bundleHash: string, serverIds: string[]): ConvexHttpClient {
  const client = new ConvexHttpClient("https://convex.example.com");
  vi.spyOn(client, "query").mockImplementation(async (...args) => {
    const name = String(args[0]);
    if (name === "plugins:listProjectPlugins") {
      return [
        {
          pluginId: PLUGIN_ID,
          name: "fixture-plugin",
          enabled: true,
          activeVersionId: VERSION_ID,
        },
      ];
    }
    if (name === "plugins:resolvePluginRuntimePreview") {
      return {
        pluginVersions: [
          {
            pluginVersionId: VERSION_ID,
            pluginId: PLUGIN_ID,
            name: "fixture-plugin",
            bundleHash,
          },
        ],
        effectiveServerIds: serverIds,
        serverComponents: serverIds.map((serverId) => ({
          pluginVersionId: VERSION_ID,
          componentKey: `server:${serverId}`,
          placement: "local",
          authenticationPolicy: "on_use",
          materializedServerId: serverId,
        })),
        pluginSkills: [],
      };
    }
    throw new Error(`unexpected query: ${name}`);
  });
  return client;
}

/** `/plugin-runtime/*`: no session to reuse, and every record succeeds. */
function stubBackend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const answers: Record<string, unknown> = {
        "/plugin-runtime/session/lookup": { session: null },
        "/plugin-runtime/session/record": { sessionId: "session-1" },
      };
      if (!(path in answers)) throw new Error(`unexpected fetch: ${path}`);
      return new Response(JSON.stringify(answers[path]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

interface FakeBox {
  handle: PluginBoxHandle;
  /** Every write (`write <path>`) and command, in the order the box saw them. */
  log: string[];
}

function makeFakeBox(options?: {
  /** The `chmod`, counted from 1, that fails. */
  failingChmod?: number;
  /** Writes land only once this settles. */
  writesOpen?: Promise<void>;
}): FakeBox {
  const files = new Set<string>();
  const log: string[] = [];
  let chmods = 0;
  const handle: PluginBoxHandle = {
    writeFiles: async (entries) => {
      await options?.writesOpen;
      for (const entry of entries) {
        log.push(`write ${entry.path}`);
        files.add(entry.path);
      }
    },
    run: async (command) => {
      log.push(command);
      const probed = /^test -f '(.+)'$/.exec(command);
      if (probed) {
        return {
          stdout: "",
          stderr: "",
          exitCode: files.has(probed[1]) ? 0 : 1,
        };
      }
      if (command.startsWith("chmod ")) {
        chmods += 1;
        if (chmods === options?.failingChmod) {
          return { stdout: "", stderr: "Operation not permitted", exitCode: 1 };
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    startShim: async () => ({ port: 41234, stop: async () => {} }),
    publicOrigin: (port) => `https://${port}-${SANDBOX_ID}.e2b.app`,
  };
  return { handle, log };
}

/** The quoted paths of a `chmod 755 '…' '…'` command. */
function chmodPaths(command: string): string[] {
  return [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

describe("pushing a plugin bundle into a box", () => {
  let cleanup: () => Promise<void>;
  let cache: PluginBundleCache;

  beforeEach(async () => {
    let root: string;
    ({ root, cleanup } = await makeCacheRoot());
    cache = new PluginBundleCache({ rootDir: root });
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    stubBackend();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.CONVEX_HTTP_URL;
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    await cleanup();
  });

  /** Cache `files` as a ZIP import would, `executables` with their bit. */
  async function cacheBundle(
    files: Record<string, string>,
    executables: string[] = [],
  ): Promise<string> {
    const bundleHash = await fixtureBundleHash(files);
    const identity = {
      projectId: PROJECT_ID,
      pluginVersionId: VERSION_ID,
      bundleHash,
    };
    await cache.materialize(identity, {
      source: await fixtureBundleSource(files),
    });
    for (const path of executables) {
      await chmod(join(cache.entryPath(identity), path), 0o755);
    }
    return bundleHash;
  }

  function ensure(bundleHash: string, box: FakeBox) {
    return ensurePluginStdioRuntime({
      client: stubClient(bundleHash, ["server-1"]),
      projectId: PROJECT_ID,
      serverId: "server-1",
      spec: SPEC,
      box: BOX,
      connect: async () => box.handle,
      cache,
    });
  }

  const boxRoot = (bundleHash: string) =>
    `/home/user/.mcpjam/plugins/${PROJECT_ID}/${VERSION_ID}/${bundleHash}`;
  const tools = () => ({
    ...fixtureBundleFiles(),
    ...Object.fromEntries(TOOLS.map((path) => [path, "#!/bin/sh\n"])),
  });

  it.skipIf(process.platform === "win32")(
    "marks a large bundle's executables a batch at a time, then the marker",
    async () => {
      const bundleHash = await cacheBundle(tools(), TOOLS);
      const box = makeFakeBox();

      const result = await ensure(bundleHash, box);

      expect(result.ok).toBe(true);
      const chmods = box.log.filter((entry) => entry.startsWith("chmod "));
      expect(chmods).toHaveLength(3);
      for (const command of chmods) {
        expect(chmodPaths(command).length).toBeLessThanOrEqual(100);
      }
      expect(chmods.flatMap(chmodPaths).sort()).toEqual(
        TOOLS.map((path) => `${boxRoot(bundleHash)}/${path}`),
      );
      const marker = box.log.indexOf(
        `write ${boxRoot(bundleHash)}/.mcpjam-bundle-complete.x1`,
      );
      expect(marker).toBeGreaterThan(box.log.lastIndexOf(chmods[2]));
    },
  );

  it.skipIf(process.platform === "win32")(
    "stops at the first batch that fails, and leaves the box unmarked",
    async () => {
      const bundleHash = await cacheBundle(tools(), TOOLS);
      const box = makeFakeBox({ failingChmod: 2 });

      const result = await ensure(bundleHash, box);

      expect(result).toMatchObject({ ok: false, reason: "shim_unavailable" });
      expect(
        box.log.filter((entry) => entry.startsWith("chmod ")),
      ).toHaveLength(2);
      expect(box.log).not.toContain(
        `write ${boxRoot(bundleHash)}/.mcpjam-bundle-complete.x1`,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "never takes a bundle file for the marker",
    async () => {
      const bundleHash = await cacheBundle(
        {
          ...fixtureBundleFiles(),
          ".mcpjam-bundle-complete.x1": "forged\n",
          "bin/tool": "#!/bin/sh\n",
        },
        ["bin/tool"],
      );
      const box = makeFakeBox({ failingChmod: 1 });

      const result = await ensure(bundleHash, box);

      expect(result).toMatchObject({ ok: false, reason: "shim_unavailable" });
      expect(box.log).not.toContain(
        `write ${boxRoot(bundleHash)}/.mcpjam-bundle-complete.x1`,
      );
    },
  );

  it("shares one push between servers of a plugin that connect together", async () => {
    const bundleHash = await cacheBundle(fixtureBundleFiles());
    let openWrites = () => {};
    const box = makeFakeBox({
      writesOpen: new Promise<void>((resolve) => {
        openWrites = () => resolve();
      }),
    });
    let connects = 0;
    // Writes land only once both servers are attached, so neither can see the
    // other's marker: pushing separately, each would upload the whole bundle.
    const connect = async () => {
      connects += 1;
      if (connects === 2) setTimeout(openWrites, 0);
      return box.handle;
    };
    const client = stubClient(bundleHash, ["server-1", "server-2"]);

    const results = await Promise.all(
      ["server-1", "server-2"].map((serverId) =>
        ensurePluginStdioRuntime({
          client,
          projectId: PROJECT_ID,
          serverId,
          spec: SPEC,
          box: BOX,
          connect,
          cache,
        }),
      ),
    );

    expect(results.map((result) => result.ok)).toEqual([true, true]);
    const uploads = box.log.filter(
      (entry) => entry === `write ${boxRoot(bundleHash)}/server/index.js`,
    );
    expect(uploads).toHaveLength(1);
  });
});
