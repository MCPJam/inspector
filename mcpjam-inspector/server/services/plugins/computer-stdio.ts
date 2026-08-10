/**
 * Hosted execution of a plugin's `stdio` MCP server: run the child inside the
 * caller's own computer sandbox, behind the in-VM shim, and let MCPJam connect
 * to it as an ordinary remote Streamable-HTTP server.
 *
 * The local sibling is `local-stdio.ts`, which spawns the child in THIS
 * process. Hosted has no process to spawn into, so the pipeline is:
 *
 *   verify the bundle HERE (only this side holds the SDK parser and the pinned
 *   hash) → push the verified bytes and the shim into the box → start the shim
 *   with a per-session bearer and the launch spec substituted for IN-BOX paths
 *   → wait for its ready line → record the session.
 *
 * Three properties this file exists to hold:
 *
 *   - COLOCATION ONLY. The child runs in the caller's own DURABLE project
 *     computer, reserved through the same idempotent call the `bash` tool
 *     makes. Nothing here creates an ephemeral sandbox for a plugin, and a
 *     scope that cannot reach a box at all gets `no_box` — the caller then
 *     keeps hosted's ordinary stdio refusal rather than acquiring a machine on
 *     a plugin's behalf.
 *   - THE SESSION ROW IS THE GATE. Reachability is admitted by a recorded
 *     session, never by "we think we started something". If the record does not
 *     land, the connect is refused even though a shim is listening — an
 *     unrecorded runtime is one nothing can find, touch or supersede.
 *   - NO SECRET IS EVER LOGGED. Not the shim bearer, not the child's env
 *     values, not its argv (where a plugin's `--api-key=` would live), and not
 *     the child's stderr, which is plugin-authored output that may quote any of
 *     them. Diagnostics carry ids, ports and counts.
 */
import { randomBytes } from "node:crypto";
import type { ConvexHttpClient } from "convex/browser";
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  ensureComputerReady,
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
} from "../../utils/computers/control-plane-client.js";
import type { ExecutionScope } from "../../utils/execution-scope.js";
import { DEFAULT_PLUGIN_BUNDLE_LIMITS } from "@mcpjam/sdk/plugin-bundle";
import { createDirectoryPluginFileSource } from "./bundle-file-sources.js";
import {
  getPluginBundleCache,
  preparePluginStdioLaunch,
  resolvePluginOriginForServer,
  type PluginBundleCache,
} from "./local-stdio.js";
import { needsPluginRoot, type PluginStdioLaunchSpec } from "./plugin-root.js";
import {
  PLUGIN_SHIM_SOURCE,
  PLUGIN_SHIM_VERSION,
} from "./shim/PluginShim.bundled.js";
import {
  lookupPluginRuntimeSession,
  recordPluginRuntimeSession,
  touchPluginRuntimeSession,
  type PluginRuntimeBoxKind,
} from "./plugin-runtime-sessions.js";

/**
 * The box a runtime colocates into. A discriminated union rather than an
 * id-plus-flags record because the two kinds are addressed by different
 * control-plane rows, and the session record stores whichever one applies.
 */
export type PluginRuntimeBox =
  | { kind: "computer"; computerId: string; sandboxId: string }
  | { kind: "sandbox"; sandboxRowId: string; sandboxId: string };

/** Everything the connect seam needs to reach a running shim. */
export interface PluginStdioRuntime {
  sessionId: string;
  /** Absolute `https://…/mcp` endpoint on the sandbox's public port. */
  url: string;
  /** Bearer the shim demands. Never logged, never returned to a browser. */
  token: string;
  shimPort: number;
  shimVersion: string;
  bundleHash: string;
  pluginId: string;
  pluginVersionId: string;
}

export type PluginStdioRuntimeFailure =
  /** No installed, enabled plugin version currently provides this server. */
  | "no_plugin_origin"
  /** The pinned version carries no hash, so nothing can be verified. */
  | "missing_bundle_hash"
  /** The verified bundle could not be produced on this machine. */
  | "bundle_unavailable"
  /** The scope has no colocatable box — hosted's refusal stands. */
  | "no_box"
  /** Files could not be placed in the box, or the shim never reported ready. */
  | "shim_unavailable"
  /** The shim is up but the session record did not land, so it is not admitted. */
  | "session_not_recorded";

export type EnsurePluginStdioRuntimeResult =
  | { ok: true; runtime: PluginStdioRuntime; reused: boolean }
  | { ok: false; reason: PluginStdioRuntimeFailure; message: string };

// ── The vendor boundary ──────────────────────────────────────────────────────

export interface PluginBoxHandle {
  /** Write files into the box, creating parent directories. */
  writeFiles(files: Array<{ path: string; bytes: Uint8Array }>): Promise<void>;
  /** Foreground command. A non-zero exit is a normal outcome, not a throw. */
  run(
    command: string,
    options?: { timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * Start the shim detached and resolve with the port from its ready line.
   * Rejects if the shim exits or stays silent past `readyTimeoutMs` — a
   * started-but-not-listening process is not a runtime.
   */
  startShim(args: {
    scriptPath: string;
    env: Record<string, string>;
    readyTimeoutMs: number;
  }): Promise<{ port: number }>;
  /** Public origin forwarding to a listening port inside the box. */
  publicOrigin(port: number): string;
}

export type PluginBoxConnector = (
  box: PluginRuntimeBox
) => Promise<PluginBoxHandle>;

// ── In-box layout ────────────────────────────────────────────────────────────

/** Mirrors `~/.mcpjam` on a local install, under the sandbox's home. */
const BOX_MCPJAM_ROOT = "/home/user/.mcpjam";

/**
 * Content-addressed, exactly like the local cache: a re-push of the same hash
 * is a no-op and a changed bundle is a different directory, so a running child
 * never has its files edited underneath it.
 */
function boxBundleRoot(args: {
  projectId: string;
  pluginVersionId: string;
  bundleHash: string;
}): string {
  return `${BOX_MCPJAM_ROOT}/plugins/${args.projectId}/${args.pluginVersionId}/${args.bundleHash}`;
}

/** Keyed by LOGICAL plugin identity so state survives a version activation. */
function boxDataDir(args: { projectId: string; pluginId: string }): string {
  return `${BOX_MCPJAM_ROOT}/plugin-data/${args.projectId}/${args.pluginId}`;
}

/** Content-addressed by shim version, so an upgrade cannot overwrite the file a
 *  still-running shim was started from. */
function boxShimPath(shimVersion: string): string {
  return `${BOX_MCPJAM_ROOT}/shim/mcpjam-plugin-shim-${shimVersion}.mjs`;
}

/** Written only after every file landed; its presence is what makes the push
 *  skippable. A partially-copied bundle therefore never looks complete. */
function boxBundleMarker(bundleRoot: string): string {
  return `${bundleRoot}/.mcpjam-bundle-complete`;
}

/** Single-quoted for `sh`, which has no escape inside single quotes. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

const READY_TIMEOUT_MS = 30_000;

/**
 * 32 random bytes, base64url — 43 characters, comfortably over the shim's
 * 32-character floor. Minted per session and never reused across restarts: the
 * token is the only thing between a public sandbox port and a process that
 * executes the plugin's command, so a superseded shim's bearer must not open
 * its replacement.
 */
function mintShimToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Can this deployment colocate a plugin's stdio child at all?
 *
 * ONE predicate, deliberately shared by the two decisions that must agree: the
 * runtime venue declared to the backend's environment resolver (which admits
 * `local`-placement components on the strength of it) and the connect seam that
 * has to make good on that admission. Splitting them is how a resolver starts
 * handing out server ids that fail at connect.
 */
export function canColocatePluginStdio(): boolean {
  return HOSTED_MODE && isComputersDataPlaneConfigured();
}

/**
 * The box a hosted turn colocates into: the acting caller's OWN project
 * computer, through the same idempotent reserve/wake the `bash` tool and the
 * harness already make. `null` — never a throw — when the scope has no box it
 * can reach (a guest, an unentitled project, a quota, a vendor outage), which
 * is what leaves hosted's ordinary stdio refusal in place.
 *
 * Nothing EPHEMERAL is ever created for a plugin: this reserves the durable
 * machine the caller already owns, and it is only ever called once a plugin
 * stdio server is genuinely being connected — a turn without one never touches
 * (or pays for) a machine.
 */
export async function resolveColocatedPluginBox(args: {
  bearer: string;
  projectId: string;
  executionScope?: ExecutionScope;
  signal?: AbortSignal;
}): Promise<PluginRuntimeBox | null> {
  if (!canColocatePluginStdio()) return null;

  const ready = await ensureComputerReady({
    bearer: args.bearer,
    projectId: args.projectId,
    ...(args.executionScope ? { executionScope: args.executionScope } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!ready.ok) {
    logger.info("[plugin-computer] no colocatable computer for this scope", {
      projectId: args.projectId,
      status: ready.status,
    });
    return null;
  }
  const info = await getComputerSandboxInfo({
    computerId: ready.value.computerId,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!info.ok || !info.value.providerComputerId) return null;

  return {
    kind: "computer",
    computerId: ready.value.computerId,
    sandboxId: info.value.providerComputerId,
  };
}

// ── The pipeline ─────────────────────────────────────────────────────────────

/**
 * Ensure a reachable shim for one plugin stdio server, reusing a live session
 * when the backend confirms one at this exact bundle and shim version.
 *
 * Returns a structured failure rather than throwing: every failure mode means
 * "hosted cannot run this server", which the connect seam already expresses as
 * one refusal, and distinguishing them is for diagnostics, not control flow.
 */
export async function ensurePluginStdioRuntime(args: {
  /** Convex client for the plugin-runtime reads (origin, bundle download). */
  client: ConvexHttpClient;
  projectId: string;
  serverId: string;
  /** The configured launch spec, placeholders still verbatim. */
  spec: PluginStdioLaunchSpec;
  /** The box the caller ALREADY has for this turn. */
  box: PluginRuntimeBox;
  connect: PluginBoxConnector;
  cache?: PluginBundleCache;
  readyTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<EnsurePluginStdioRuntimeResult> {
  const cache = args.cache ?? getPluginBundleCache();

  // The origin FIRST, and on its own: the pinned bundle hash is what the
  // session lookup is keyed on, and a reuse must not pay for materializing a
  // bundle the box already holds. This is the backend's own lifecycle-enforcing
  // resolver, so a disabled or uninstalled plugin stops resolving here at once.
  const origin = await resolvePluginOriginForServer(args.client, {
    projectId: args.projectId,
    serverId: args.serverId,
  });
  if (!origin) {
    return {
      ok: false,
      reason: "no_plugin_origin",
      message: `Server "${args.serverId}" is a plugin component but no installed, enabled plugin version currently provides it.`,
    };
  }
  if (!origin.bundleHash) {
    return {
      ok: false,
      reason: "missing_bundle_hash",
      message: `Plugin "${origin.name}" reports no bundle hash, so its files cannot be verified.`,
    };
  }
  const bundleHash = origin.bundleHash;
  const placement = {
    pluginRoot: boxBundleRoot({
      projectId: args.projectId,
      pluginVersionId: origin.pluginVersionId,
      bundleHash,
    }),
    dataDir: boxDataDir({
      projectId: args.projectId,
      pluginId: origin.pluginId,
    }),
  };

  const existing = await lookupPluginRuntimeSession({
    serverId: args.serverId,
    expectedBundleHash: bundleHash,
    shimVersion: PLUGIN_SHIM_VERSION,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (existing.session && sessionMatchesBox(existing.session, args.box)) {
    const handle = await args.connect(args.box);
    await touchPluginRuntimeSession({
      sessionId: existing.session.sessionId,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    return {
      ok: true,
      reused: true,
      runtime: {
        sessionId: existing.session.sessionId,
        url: `${handle.publicOrigin(existing.session.shimPort)}/mcp`,
        token: existing.session.shimToken,
        shimPort: existing.session.shimPort,
        shimVersion: existing.session.shimVersion,
        bundleHash: existing.session.bundleHash,
        pluginId: origin.pluginId,
        pluginVersionId: origin.pluginVersionId,
      },
    };
  }
  if (existing.stale) {
    logger.info("[plugin-computer] replacing a stale plugin runtime", {
      serverId: args.serverId,
      stale: existing.stale,
    });
  }

  // Materialize + verify HERE (only this side holds the SDK parser and the
  // pin), but substitute for the BOX: this machine holds the bytes, it never
  // runs them.
  const prepared = await preparePluginStdioLaunch({
    client: args.client,
    cache,
    projectId: args.projectId,
    serverId: args.serverId,
    spec: args.spec,
    leaseId: `computer:${args.serverId}`,
    remotePlacement: placement,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      reason: "bundle_unavailable",
      message: `Plugin component "${args.serverId}" could not be prepared (${prepared.reason}).`,
    };
  }

  try {
    let handle: PluginBoxHandle;
    try {
      handle = await args.connect(args.box);
    } catch (error) {
      logger.warn("[plugin-computer] could not attach to the box", {
        serverId: args.serverId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        reason: "no_box",
        message: "The computer for this turn could not be reached.",
      };
    }

    const token = mintShimToken();
    let port: number;
    try {
      await pushBundleIntoBox({
        handle,
        localRoot: prepared.pluginRoot,
        boxRoot: placement.pluginRoot,
        bundleHash,
      });
      await pushShimIntoBox(handle);
      // The spec REQUIRES this directory to exist before launch; the child owns
      // its contents and MCPJam never reads them back.
      await handle.run(`mkdir -p ${shellQuote(placement.dataDir)}`);
      ({ port } = await handle.startShim({
        scriptPath: boxShimPath(PLUGIN_SHIM_VERSION),
        env: {
          MCPJAM_SHIM_PORT: "0",
          MCPJAM_SHIM_TOKEN: token,
          MCPJAM_SHIM_LAUNCH: JSON.stringify({
            command: prepared.launch.command,
            args: prepared.launch.args,
            env: prepared.launch.env,
            // The shim's key is `cwd` (the `spawn` name); an unmapped
            // `workingDirectory` is a startup failure there, by design.
            ...(prepared.launch.workingDirectory !== undefined
              ? { cwd: prepared.launch.workingDirectory }
              : {}),
          }),
        },
        readyTimeoutMs: args.readyTimeoutMs ?? READY_TIMEOUT_MS,
      }));
    } catch (error) {
      logger.warn("[plugin-computer] shim did not come up", {
        serverId: args.serverId,
        pluginId: prepared.origin.pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        reason: "shim_unavailable",
        message: "The plugin's server could not be started on the computer.",
      };
    }

    const sessionId = await recordPluginRuntimeSession({
      serverId: args.serverId,
      pluginVersionId: prepared.origin.pluginVersionId,
      projectId: args.projectId,
      bundleHash,
      boxKind: args.box.kind,
      ...(args.box.kind === "computer"
        ? { computerId: args.box.computerId }
        : { sandboxRowId: args.box.sandboxRowId }),
      shimPort: port,
      shimToken: token,
      shimVersion: PLUGIN_SHIM_VERSION,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!sessionId) {
      // A shim is listening, and we still refuse: without the record nothing
      // can supersede or reap it, and admitting an unrecorded runtime would
      // make the gate advisory.
      return {
        ok: false,
        reason: "session_not_recorded",
        message:
          "The plugin's server started but could not be registered, so it was not used.",
      };
    }

    return {
      ok: true,
      reused: false,
      runtime: {
        sessionId,
        url: `${handle.publicOrigin(port)}/mcp`,
        token,
        shimPort: port,
        shimVersion: PLUGIN_SHIM_VERSION,
        bundleHash,
        pluginId: prepared.origin.pluginId,
        pluginVersionId: prepared.origin.pluginVersionId,
      },
    };
  } finally {
    // The child runs from the BOX's copy, so the local cache entry only has to
    // survive the upload above.
    prepared.release();
  }
}

function sessionMatchesBox(
  session: {
    boxKind: PluginRuntimeBoxKind;
    computerId: string | null;
    sandboxRowId: string | null;
  },
  box: PluginRuntimeBox
): boolean {
  // A session in a DIFFERENT box is not reachable from this turn's box, and its
  // port would resolve to a public host that forwards somewhere else entirely.
  if (session.boxKind !== box.kind) return false;
  return box.kind === "computer"
    ? session.computerId === box.computerId
    : session.sandboxRowId === box.sandboxRowId;
}

/**
 * Copy the verified bundle into the box, skipping the copy when the marker
 * proves this exact hash already landed. Reads from the local cache entry the
 * SDK parser just verified — never from the download — so what reaches the box
 * is content that hashed to the pin.
 */
async function pushBundleIntoBox(args: {
  handle: PluginBoxHandle;
  localRoot: string;
  boxRoot: string;
  bundleHash: string;
}): Promise<void> {
  const marker = boxBundleMarker(args.boxRoot);
  const probe = await args.handle.run(`test -f ${shellQuote(marker)}`);
  if (probe.exitCode === 0) return;

  const source = createDirectoryPluginFileSource(args.localRoot);
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of await source.list()) {
    if (entry.kind === "directory") continue;
    files.push({
      path: `${args.boxRoot}/${entry.path}`,
      bytes: await source.readBytes(
        entry.path,
        DEFAULT_PLUGIN_BUNDLE_LIMITS.maxFileBytes
      ),
    });
  }
  await args.handle.writeFiles(files);
  // Last, and only on success: the marker is a claim that every file above is
  // present, so writing it earlier would make a failed push look complete.
  await args.handle.writeFiles([
    { path: marker, bytes: new TextEncoder().encode(`${args.bundleHash}\n`) },
  ]);
}

/** Upload the shim unless its content-addressed path already exists. */
async function pushShimIntoBox(handle: PluginBoxHandle): Promise<void> {
  const path = boxShimPath(PLUGIN_SHIM_VERSION);
  const probe = await handle.run(`test -f ${shellQuote(path)}`);
  if (probe.exitCode === 0) return;
  await handle.writeFiles([
    { path, bytes: new TextEncoder().encode(PLUGIN_SHIM_SOURCE) },
  ]);
}

export { needsPluginRoot };
