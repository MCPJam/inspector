/**
 * Hosted plugin-stdio colocation, end to end against a stubbed VENDOR and a
 * stubbed backend — never against stubs of this module's own functions. What is
 * faked is exactly the two things this process does not own: the sandbox
 * (`PluginBoxConnector`) and the `/plugin-runtime/*` routes (`fetch`). The
 * bundle cache, the SDK parse/verify, placeholder substitution, the in-box
 * layout and every admission decision are the real ones.
 *
 * The refusal paths are asserted as carefully as the success path: an
 * unrecorded runtime, a shim that never listens and a session belonging to a
 * different box must all end with NO reachable endpoint, because the connect
 * seam turns "no runtime" straight back into hosted's stdio refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import { PluginBundleCache } from "../bundle-cache.js";
import {
  ensurePluginStdioRuntime,
  type PluginBoxHandle,
  type PluginRuntimeBox,
} from "../computer-stdio.js";
import { PLUGIN_SHIM_VERSION } from "../shim/PluginShim.bundled.js";
import {
  fixtureBundleHash,
  fixtureBundleSource,
  makeCacheRoot,
} from "./fixture-bundle.js";

const PROJECT_ID = "project-1";
const PLUGIN_ID = "plugin-1";
const VERSION_ID = "version-1";
const SERVER_ID = "server-1";
const SANDBOX_ID = "sbx-abc";
const COMPUTER_ID = "computer-1";

const BOX: PluginRuntimeBox = {
  kind: "computer",
  computerId: COMPUTER_ID,
  sandboxId: SANDBOX_ID,
};

const SPEC = {
  command: "node",
  args: ["${PLUGIN_ROOT}/server/index.js"],
  env: { STATE_DIR: "${PLUGIN_DATA}" },
  workingDirectory: "${PLUGIN_ROOT}",
};

function stubClient(bundleHash: string): ConvexHttpClient {
  return {
    async query(name: string) {
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
          effectiveServerIds: [SERVER_ID],
          serverComponents: [
            {
              pluginVersionId: VERSION_ID,
              componentKey: "server:fixture-local",
              placement: "local",
              authenticationPolicy: "on_use",
              materializedServerId: SERVER_ID,
            },
          ],
          pluginSkills: [],
        };
      }
      throw new Error(`unexpected query: ${name}`);
    },
  } as unknown as ConvexHttpClient;
}

/** No plugin version claims this server — the fail-closed origin case. */
function stubClientWithNoOrigin(): ConvexHttpClient {
  return {
    async query(name: string) {
      if (name === "plugins:listProjectPlugins") return [];
      throw new Error(`unexpected query: ${name}`);
    },
  } as unknown as ConvexHttpClient;
}

interface FakeBox {
  handle: PluginBoxHandle;
  /** Absolute in-box path → bytes. */
  files: Map<string, Uint8Array>;
  commands: string[];
  starts: Array<{ scriptPath: string; env: Record<string, string> }>;
  /** How many times a started shim was asked to stop. */
  stops: number;
}

function makeFakeBox(options?: {
  /** Reject the start instead of reporting a port. */
  neverReady?: boolean;
  port?: number;
  /** Pre-existing files, e.g. a marker from an earlier push. */
  seed?: Map<string, Uint8Array>;
  /** Exit code for `mkdir -p` (default 0). */
  mkdirExitCode?: number;
}): FakeBox {
  const files = options?.seed ?? new Map<string, Uint8Array>();
  const commands: string[] = [];
  const starts: Array<{ scriptPath: string; env: Record<string, string> }> = [];
  const box = { files, commands, starts, stops: 0 } as FakeBox;
  box.handle = {
    writeFiles: async (entries) => {
      for (const entry of entries) files.set(entry.path, entry.bytes);
    },
    run: async (command) => {
      commands.push(command);
      const match = /^test -f '(.+)'$/.exec(command);
      if (match) {
        return {
          stdout: "",
          stderr: "",
          exitCode: files.has(match[1].split(`'\\''`).join("'")) ? 0 : 1,
        };
      }
      if (command.startsWith("mkdir -p ")) {
        return {
          stdout: "",
          stderr: "",
          exitCode: options?.mkdirExitCode ?? 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    startShim: async ({ scriptPath, env }) => {
      starts.push({ scriptPath, env });
      if (options?.neverReady) {
        throw new Error("the plugin shim did not report listening");
      }
      return {
        port: options?.port ?? 41234,
        stop: async () => {
          box.stops += 1;
        },
      };
    },
    publicOrigin: (port) => `https://${port}-${SANDBOX_ID}.e2b.app`,
  };
  return box;
}

/** The `/plugin-runtime/*` backend, recorded so the tests can assert what was
 *  admitted rather than only what was returned. */
function stubBackend(options?: {
  lookup?: unknown;
  /** `null` makes `record` answer without a sessionId. */
  sessionId?: string | null;
}) {
  const calls: Array<{ path: string; body: any }> = [];
  const fetchMock = vi.fn(async (input: any, init: any) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init.body));
    calls.push({ path, body });
    if (path === "/plugin-runtime/session/lookup") {
      return new Response(
        JSON.stringify(options?.lookup ?? { session: null }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (path === "/plugin-runtime/session/record") {
      const sessionId =
        options?.sessionId === undefined ? "session-1" : options.sessionId;
      return new Response(JSON.stringify(sessionId ? { sessionId } : {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/plugin-runtime/session/touch") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

describe("ensurePluginStdioRuntime", () => {
  let cacheRoot: string;
  let cleanup: () => Promise<void>;
  let cache: PluginBundleCache;
  let bundleHash: string;

  beforeEach(async () => {
    ({ root: cacheRoot, cleanup } = await makeCacheRoot());
    cache = new PluginBundleCache({ rootDir: cacheRoot });
    bundleHash = await fixtureBundleHash();
    // Seed the verified cache so the pipeline exercises placement, not the
    // download it already shares with the local path.
    await cache.materialize(
      { projectId: PROJECT_ID, pluginVersionId: VERSION_ID, bundleHash },
      { source: await fixtureBundleSource() }
    );
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.CONVEX_HTTP_URL;
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    await cleanup();
  });

  const boxBundleRoot = () =>
    `/home/user/.mcpjam/plugins/${PROJECT_ID}/${VERSION_ID}/${bundleHash}`;
  const boxDataDir = () =>
    `/home/user/.mcpjam/plugin-data/${PROJECT_ID}/${PLUGIN_ID}`;

  async function ensure(box: FakeBox, client?: ConvexHttpClient) {
    return ensurePluginStdioRuntime({
      client: client ?? stubClient(bundleHash),
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      spec: SPEC,
      box: BOX,
      connect: async () => box.handle,
      cache,
    });
  }

  it("pushes the verified bundle and shim, starts the child, and records the session", async () => {
    const backend = stubBackend();
    const box = makeFakeBox();

    const result = await ensure(box);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reused).toBe(false);
    expect(result.runtime.url).toBe(
      `https://41234-${SANDBOX_ID}.e2b.app/mcp`
    );

    // The bundle landed content-addressed, and the completion marker is what
    // makes a re-push skippable.
    expect(box.files.has(`${boxBundleRoot()}/server/index.js`)).toBe(true);
    expect(box.files.has(`${boxBundleRoot()}/plugin.json`)).toBe(true);
    expect(
      box.files.has(`${boxBundleRoot()}/.mcpjam-bundle-complete`)
    ).toBe(true);
    expect(
      box.files.has(
        `/home/user/.mcpjam/shim/mcpjam-plugin-shim-${PLUGIN_SHIM_VERSION}.mjs`
      )
    ).toBe(true);
    expect(box.commands).toContain(`mkdir -p '${boxDataDir()}'`);

    // The launch spec resolves to IN-BOX paths, and rides the shim's `cwd`
    // key — an unmapped `workingDirectory` is a startup failure over there.
    const env = box.starts[0].env;
    const launch = JSON.parse(env.MCPJAM_SHIM_LAUNCH);
    expect(launch).toEqual({
      command: "node",
      args: [`${boxBundleRoot()}/server/index.js`],
      env: {
        PLUGIN_ROOT: boxBundleRoot(),
        PLUGIN_DATA: boxDataDir(),
        STATE_DIR: boxDataDir(),
      },
      cwd: boxBundleRoot(),
    });
    expect(launch.workingDirectory).toBeUndefined();
    expect(env.MCPJAM_SHIM_PORT).toBe("0");

    // The bearer is freshly minted, over the shim's 32-character floor, and is
    // what the caller is told to present.
    expect(env.MCPJAM_SHIM_TOKEN.length).toBeGreaterThanOrEqual(32);
    expect(result.runtime.token).toBe(env.MCPJAM_SHIM_TOKEN);

    const record = backend.calls.find(
      (call) => call.path === "/plugin-runtime/session/record"
    );
    expect(record?.body).toMatchObject({
      serverId: SERVER_ID,
      projectId: PROJECT_ID,
      pluginVersionId: VERSION_ID,
      bundleHash,
      boxKind: "computer",
      computerId: COMPUTER_ID,
      shimPort: 41234,
      shimVersion: PLUGIN_SHIM_VERSION,
    });
    expect(record?.body.sandboxRowId).toBeUndefined();
  });

  it("authenticates the session routes with the inspector service token", async () => {
    const backend = stubBackend();
    await ensure(makeFakeBox());
    for (const call of backend.fetchMock.mock.calls) {
      expect((call[1] as any).headers["x-inspector-service-token"]).toBe(
        "service-token"
      );
    }
  });

  it("skips re-pushing a bundle the box already holds", async () => {
    stubBackend();
    const seed = new Map<string, Uint8Array>([
      [
        `${boxBundleRoot()}/.mcpjam-bundle-complete`,
        new TextEncoder().encode(bundleHash),
      ],
      [
        `/home/user/.mcpjam/shim/mcpjam-plugin-shim-${PLUGIN_SHIM_VERSION}.mjs`,
        new TextEncoder().encode("shim"),
      ],
    ]);
    const box = makeFakeBox({ seed });

    const result = await ensure(box);

    expect(result.ok).toBe(true);
    // Only the pre-seeded entries: neither the bundle nor the shim was rewritten.
    expect([...box.files.keys()].sort()).toEqual([...seed.keys()].sort());
  });

  it("reuses a live session for the same box without starting a second shim", async () => {
    const backend = stubBackend({
      lookup: {
        session: {
          sessionId: "session-live",
          boxKind: "computer",
          computerId: COMPUTER_ID,
          sandboxRowId: null,
          shimPort: 40100,
          shimToken: "x".repeat(43),
          shimVersion: PLUGIN_SHIM_VERSION,
          bundleHash: "seeded-at-lookup",
        },
      },
    });
    const box = makeFakeBox();

    const result = await ensure(box);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reused).toBe(true);
    expect(result.runtime.sessionId).toBe("session-live");
    expect(result.runtime.token).toBe("x".repeat(43));
    expect(result.runtime.url).toBe(`https://40100-${SANDBOX_ID}.e2b.app/mcp`);
    expect(box.starts).toHaveLength(0);
    expect(box.files.size).toBe(0);
    expect(
      backend.calls.map((call) => call.path)
    ).toEqual([
      "/plugin-runtime/session/lookup",
      "/plugin-runtime/session/touch",
    ]);
  });

  it("does not reuse a session recorded against a different box", async () => {
    stubBackend({
      lookup: {
        session: {
          sessionId: "session-elsewhere",
          boxKind: "computer",
          computerId: "some-other-computer",
          sandboxRowId: null,
          shimPort: 40100,
          shimToken: "x".repeat(43),
          shimVersion: PLUGIN_SHIM_VERSION,
          bundleHash,
        },
      },
    });
    const box = makeFakeBox();

    const result = await ensure(box);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A port in someone else's box forwards somewhere else entirely.
    expect(result.reused).toBe(false);
    expect(result.runtime.sessionId).toBe("session-1");
    expect(box.starts).toHaveLength(1);
  });

  it("refuses when the session record does not land, even though the shim is up", async () => {
    stubBackend({ sessionId: null });
    const box = makeFakeBox();

    const result = await ensure(box);

    expect(result).toMatchObject({ ok: false, reason: "session_not_recorded" });
    // The shim genuinely started — the refusal is the missing GATE, not a
    // failed launch.
    expect(box.starts).toHaveLength(1);
    // ...and precisely BECAUSE nothing can find it, it must be reaped here.
    // Left running it would sit in the user's durable computer forever, and
    // every retry would add another.
    expect(box.stops).toBe(1);
  });

  it("leaves no shim running after a successful start it did admit", async () => {
    stubBackend();
    const box = makeFakeBox();

    const result = await ensure(box);

    expect(result.ok).toBe(true);
    expect(box.stops).toBe(0);
  });

  it("refuses before starting a shim when the data directory cannot be created", async () => {
    const backend = stubBackend();
    const box = makeFakeBox({ mkdirExitCode: 1 });

    const result = await ensure(box);

    expect(result).toMatchObject({ ok: false, reason: "shim_unavailable" });
    // `run` reports a bad exit rather than throwing, so an unchecked call would
    // have launched the child against a `${PLUGIN_DATA}` that does not exist.
    expect(box.starts).toHaveLength(0);
    expect(
      backend.calls.some(
        (call) => call.path === "/plugin-runtime/session/record"
      )
    ).toBe(false);
  });

  it("refuses when the pinned version moves between the two origin reads", async () => {
    const backend = stubBackend();
    const box = makeFakeBox();
    // The preparation re-resolves the origin. A version activation landing in
    // that window would otherwise publish the NEW bytes under the OLD
    // content-addressed path and record a hash the running shim is not serving.
    // The activated version's bundle is materializable (in production it would
    // be downloadable), so preparation SUCCEEDS and the pin check is what
    // refuses — rather than the materializer failing closed for an unrelated
    // reason and hiding the window this test is about.
    await cache.materialize(
      { projectId: PROJECT_ID, pluginVersionId: "version-2", bundleHash },
      { source: await fixtureBundleSource() }
    );
    let previewReads = 0;
    const drifting = {
      async query(name: string) {
        if (name === "plugins:listProjectPlugins") {
          return [
            {
              pluginId: PLUGIN_ID,
              name: "fixture-plugin",
              enabled: true,
              activeVersionId: previewReads === 0 ? VERSION_ID : "version-2",
            },
          ];
        }
        if (name === "plugins:resolvePluginRuntimePreview") {
          const drifted = previewReads > 0;
          previewReads += 1;
          const versionId = drifted ? "version-2" : VERSION_ID;
          return {
            pluginVersions: [
              {
                pluginVersionId: versionId,
                pluginId: PLUGIN_ID,
                name: "fixture-plugin",
                bundleHash,
              },
            ],
            effectiveServerIds: [SERVER_ID],
            serverComponents: [
              {
                pluginVersionId: versionId,
                componentKey: "server:fixture-local",
                placement: "local",
                authenticationPolicy: "on_use",
                materializedServerId: SERVER_ID,
              },
            ],
            pluginSkills: [],
          };
        }
        throw new Error(`unexpected query: ${name}`);
      },
    } as unknown as ConvexHttpClient;

    const result = await ensure(box, drifting);

    expect(result).toMatchObject({ ok: false, reason: "pin_moved" });
    // Refused at the last point where refusing is still free: nothing uploaded,
    // nothing started, nothing recorded.
    expect(box.files.size).toBe(0);
    expect(box.starts).toHaveLength(0);
    expect(
      backend.calls.some(
        (call) => call.path === "/plugin-runtime/session/record"
      )
    ).toBe(false);
  });

  it("omits `cwd` entirely for a component that declares no working directory", async () => {
    stubBackend();
    const box = makeFakeBox();

    const result = await ensurePluginStdioRuntime({
      client: stubClient(bundleHash),
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      // No `workingDirectory`: the shim rejects unknown launch keys, so an
      // absent one must be absent rather than present-and-undefined.
      spec: { command: "node", args: ["${PLUGIN_ROOT}/server/index.js"], env: {} },
      box: BOX,
      connect: async () => box.handle,
      cache,
    });

    expect(result.ok).toBe(true);
    const launch = JSON.parse(box.starts[0].env.MCPJAM_SHIM_LAUNCH);
    expect("cwd" in launch).toBe(false);
    expect(launch).toEqual({
      command: "node",
      args: [`${boxBundleRoot()}/server/index.js`],
      env: { PLUGIN_ROOT: boxBundleRoot(), PLUGIN_DATA: boxDataDir() },
    });
  });

  it("refuses an id that would not compose into a safe in-box path", async () => {
    stubBackend();
    const box = makeFakeBox();

    const result = await ensurePluginStdioRuntime({
      client: stubClient(bundleHash),
      // `${BOX_MCPJAM_ROOT}/shim` holds the file the box executes, so a
      // traversing segment is a reachable target. Backend ids never look like
      // this; the guard is what keeps that from being load-bearing.
      projectId: "../../shim",
      serverId: SERVER_ID,
      spec: SPEC,
      box: BOX,
      connect: async () => box.handle,
      cache,
    });

    expect(result).toMatchObject({ ok: false, reason: "unsafe_identity" });
    expect(box.files.size).toBe(0);
    expect(box.starts).toHaveLength(0);
  });

  it("refuses when the shim never reports listening", async () => {
    const backend = stubBackend();
    const box = makeFakeBox({ neverReady: true });

    const result = await ensure(box);

    expect(result).toMatchObject({ ok: false, reason: "shim_unavailable" });
    expect(
      backend.calls.some(
        (call) => call.path === "/plugin-runtime/session/record"
      )
    ).toBe(false);
  });

  it("refuses a server no installed, enabled plugin version provides", async () => {
    const backend = stubBackend();
    const box = makeFakeBox();

    const result = await ensure(box, stubClientWithNoOrigin());

    expect(result).toMatchObject({ ok: false, reason: "no_plugin_origin" });
    expect(box.starts).toHaveLength(0);
    // Not even a lookup: without an attested origin there is no bundle hash to
    // key one on.
    expect(backend.calls).toHaveLength(0);
  });

  it("never lets the shim bearer reach an argv or a command line", async () => {
    stubBackend();
    const box = makeFakeBox();

    const result = await ensure(box);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const command of box.commands) {
      expect(command).not.toContain(result.runtime.token);
    }
    expect(box.starts[0].scriptPath).not.toContain(result.runtime.token);
  });
});
