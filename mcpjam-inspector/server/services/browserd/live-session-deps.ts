/**
 * VALIDATE-ON-STAGING — the ONLY live E2B/Convex seam construction for
 * durable browser sessions. Everything decision-bearing lives (unit-tested)
 * in `browser-session.ts`; this file supplies the real deps:
 *
 *   - reserve/ensure a desktop computer via the control plane (user bearer,
 *     `runtimeKind: "desktop-browser"` — never omit the kind);
 *   - exchange the computer id for its vendor sandbox id (service token);
 *   - connect to the sandbox via `@e2b/desktop` (a superset of the core `e2b`
 *     Sandbox: same commands/files/getHost, plus the desktop `stream` API the
 *     M0 spike validated — `stream.start({ requireAuth: true })` mints the
 *     password and holds it in memory, which is exactly why the session row
 *     must cache it);
 *   - the daemon bundle bytes embedded in the server build, and their sha256
 *     (the row's `bundleHash` identity).
 *
 * The W1 debug route (`routes/internal/computer-browser-debug.ts`) shares the
 * adapters below so the staging probe exercises the SAME seam construction
 * production uses.
 *
 * NOTE the reuse path never touches this file's sandbox half: a healthy
 * daemon is verified over HTTP alone. Only relaunches pay the connect cost —
 * and only relaunches can be broken by a wrong guess in here, which is what
 * the morning staging probe exists to catch.
 */
import { createHash } from "node:crypto";
import type { Sandbox } from "e2b";
import { logger } from "../../utils/logger.js";
import {
  ensureComputerReady,
  getComputerSandboxInfo,
  touchComputerActivity,
} from "../../utils/computers/control-plane-client.js";
import { bootBrowserd, type BrowserdSandbox } from "./boot-browserd.js";
import { BrowserdClient } from "./browserd-client.js";
import { HostedReserveError } from "./hosted-reserve-error.js";
import {
  claimBrowserRelaunch,
  lookupBrowserSession,
  recordBrowserSession,
  releaseBrowserRelaunch,
  touchBrowserSession,
} from "./browser-sessions-client.js";
import {
  ensureBrowserSession,
  type BrowserSessionDeps,
  type ComputerHostedBrowserSessionHandle,
  type HostedBrowserSessionHandle,
  type SandboxHostedBrowserSessionHandle,
  type EnsureBrowserSessionArgs,
  type SessionSandbox,
} from "./browser-session.js";
import { MCPJAM_BROWSERD_BUNDLE_BASE64 } from "./dist/mcpjam-browserd-bundle.generated.js";

/**
 * The daemon bundle bytes. Decoded from the const the bundler embeds INTO the
 * server build (base64), so it is always present in the production Docker
 * image — a sibling `.mjs` resolved by path would be absent, since the final
 * Docker stage copies only `dist/`.
 */
let cachedBundle: Uint8Array | null = null;
export function loadBrowserdBundle(): Uint8Array {
  if (!cachedBundle) {
    cachedBundle = new Uint8Array(
      Buffer.from(MCPJAM_BROWSERD_BUNDLE_BASE64, "base64"),
    );
  }
  return cachedBundle;
}

/** sha256 (hex) of the bundle bytes — the session row's `bundleHash`. */
let cachedBundleHash: string | null = null;
export function browserdBundleHash(): string {
  if (!cachedBundleHash) {
    cachedBundleHash = createHash("sha256")
      .update(loadBrowserdBundle())
      .digest("hex");
  }
  return cachedBundleHash;
}

/** The core sandbox surface the adapters need (both `e2b`'s Sandbox and
 *  `@e2b/desktop`'s subclass satisfy it). */
export interface ConnectedSandboxLike {
  commands: {
    run(
      command: string,
      options?: {
        background?: boolean;
        envs?: Record<string, string>;
        timeoutMs?: number;
        onStdout?: (chunk: string) => void;
      },
    ): Promise<any>;
  };
  files: {
    write(path: string, data: ArrayBuffer): Promise<unknown>;
    makeDir(path: string): Promise<unknown>;
    /**
     * Optional because an older `@e2b/desktop` may not expose it, and because
     * every failure to read means the same thing to the caller: boot a daemon
     * yourself.
     */
    read?(path: string): Promise<string | Uint8Array>;
  };
  getHost(port: number): string;
}

/** Adapt a connected sandbox to the boot recipe's `BrowserdSandbox`. */
export function adaptSandbox(sandbox: ConnectedSandboxLike): BrowserdSandbox {
  return {
    async runBackground(command, { envs, onStdout }) {
      const handle = await sandbox.commands.run(command, {
        background: true,
        envs,
        timeoutMs: 0,
        onStdout,
      });
      return { kill: () => handle.kill(), wait: () => handle.wait() };
    },
    async run(command, options) {
      try {
        const result = await sandbox.commands.run(command, {
          envs: options?.envs,
          timeoutMs: 30_000,
        });
        return { exitCode: Number(result?.exitCode ?? 0) };
      } catch (error) {
        // The E2B SDK rejects on a non-zero exit. The caller asked for the
        // exit CODE — a failing probe is an answer, not an error — so recover
        // it when the SDK carried one, and read anything else as a failure.
        const code = (error as { exitCode?: unknown })?.exitCode;
        return { exitCode: typeof code === "number" ? code : 1 };
      }
    },
    getHost: (port) => sandbox.getHost(port),
  };
}

/**
 * Read a small text file out of the sandbox.
 *
 * The prelaunch token's channel. A daemon baked into the image mints its own
 * bearer into a 0600 file, and this is how the inspector learns it — over the
 * SAME API-key-authenticated files API that already writes the daemon's bytes
 * (`writeBundleInto`), so no new trust relationship is created. The agent's own
 * shell runs on a different box (a different `runtimeKind`), so nothing the
 * model drives can reach the file.
 *
 * `undefined` for "not there", which is the ordinary answer on an image that
 * predates prelaunch, and the answer the caller treats as "boot one yourself".
 */
export async function readTextFileFrom(
  sandbox: ConnectedSandboxLike,
  path: string,
): Promise<string | undefined> {
  try {
    if (!sandbox.files.read) return undefined;
    const raw = await sandbox.files.read(path);
    const text =
      typeof raw === "string" ? raw : new TextDecoder().decode(raw as never);
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    // A missing file, an unreadable one, an SDK that does not have `read`:
    // every one of them means the same thing to the caller.
    return undefined;
  }
}

/** Write `content` at `path`, creating the parent directory idempotently. */
export async function writeBundleInto(
  sandbox: ConnectedSandboxLike,
  path: string,
  content: Uint8Array,
): Promise<void> {
  const slash = path.lastIndexOf("/");
  const dir = slash > 0 ? path.slice(0, slash) : "";
  if (dir) {
    try {
      await sandbox.files.makeDir(dir);
    } catch {
      // Idempotent: a real problem surfaces as the write's own error.
    }
  }
  const data = new ArrayBuffer(content.byteLength);
  new Uint8Array(data).set(content);
  await sandbox.files.write(path, data);
}

/** The desktop-stream surface of `@e2b/desktop`, feature-detected at runtime
 *  (the exact shapes are a staging-validation concern, not a compile one). */
interface DesktopStreamLike {
  start(options?: { requireAuth?: boolean }): Promise<unknown>;
  getAuthKey(): Promise<string> | string;
  getUrl(options?: { authKey?: string; viewOnly?: boolean }): string;
}

function streamOf(sandbox: unknown): DesktopStreamLike | null {
  const stream = (sandbox as { stream?: unknown }).stream;
  if (!stream || typeof stream !== "object") return null;
  const candidate = stream as Partial<DesktopStreamLike>;
  return typeof candidate.start === "function" &&
    typeof candidate.getAuthKey === "function" &&
    typeof candidate.getUrl === "function"
    ? (candidate as DesktopStreamLike)
    : null;
}

/**
 * Reset a stream this process cannot speak for.
 *
 * `x11vnc` holds the password and the noVNC proxy in front of it serves the
 * page. Both are sandbox processes that outlive whichever inspector replica
 * started them, and `@e2b/desktop`'s own `stop()` only kills the proxy handle
 * ITS instance owns — which a fresh `connect` does not have. So the reset is
 * done here, by name, and covers both.
 */
const STREAM_RESET_COMMAND =
  "pkill x11vnc || true; pkill -f novnc_proxy || true";

/**
 * Ensure the desktop stream is up with auth required and return its URL +
 * minted password. `MCPJAM_BROWSER_STREAM_DISABLED=1` is a staging bring-up
 * hatch: it records a well-formed but deliberately unusable stream so the
 * command path can be validated before the stream seam is.
 *
 * THE PASSWORD IS NOT RETRIEVABLE, only mintable. `stream.start()` generates it
 * and keeps it in memory on that `VNCServer` instance; `getAuthKey()` reads
 * that field and nothing else. A stream left running by an earlier session —
 * another replica, or this box's WebMCP Inspector session an hour ago — makes
 * `start()` throw "Stream is already running", and the fresh instance then has
 * no password to report:
 *
 *     Unable to retrieve stream auth key, check if requireAuth is enabled
 *
 * which is what reached the model as a failed `browser_navigate`. Swallowing
 * "already running" was only ever safe for a stream THIS instance had started.
 *
 * So an already-running stream is reset and restarted, minting a key we hold.
 * That rotates the password, which is what a relaunch does anyway (see the
 * comment on the relaunch path in `browser-session.ts`) — and it is the only
 * outcome that leaves the row's durable copy actually matching the box.
 */
export async function ensureStreamOn(
  sandbox: ConnectedSandboxLike,
): Promise<{ streamUrl: string; streamPassword: string }> {
  if (process.env.MCPJAM_BROWSER_STREAM_DISABLED === "1") {
    return {
      streamUrl: "https://stream-disabled.invalid/vnc.html",
      streamPassword: "stream-disabled",
    };
  }
  const stream = streamOf(sandbox);
  if (!stream) {
    throw new Error(
      "desktop stream API unavailable — is @e2b/desktop installed and is this a desktop sandbox?",
    );
  }
  try {
    await stream.start({ requireAuth: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Anything but "already running" is a real failure the caller must surface.
    if (!/already/i.test(message)) throw error;
    logger.info(
      "[browserd] desktop stream was already running; restarting it to mint a key this process holds",
    );
    await sandbox.commands
      .run(STREAM_RESET_COMMAND, { timeoutMs: 15_000 })
      .catch(() => {
        // Best-effort: if the reset could not run, the restart below fails
        // with the SDK's own error, which says more than this would.
      });
    await stream.start({ requireAuth: true });
  }
  const streamPassword = String(await stream.getAuthKey());
  if (!streamPassword) {
    throw new Error("desktop stream returned an empty auth key");
  }
  // The bare URL, no key embedded: the row stores URL and password as
  // separate fields, and the panel decides how to present them.
  const streamUrl = stream.getUrl();
  if (!streamUrl) {
    throw new Error("desktop stream returned an empty url");
  }
  return { streamUrl, streamPassword };
}

/** Reap any daemon from a previous boot; idempotent by construction. */
async function killBrowserdIn(sandbox: ConnectedSandboxLike): Promise<void> {
  await sandbox.commands
    .run("pkill -f mcpjam-browserd.mjs || true")
    .catch(() => {
      // A kill that cannot run surfaces as the boot's own port conflict.
    });
}

/** Adapt a connected desktop sandbox to the session orchestration's seam. */
export function connectSessionSandbox(
  sandbox: ConnectedSandboxLike,
): SessionSandbox {
  return {
    writeBundle: (path, content) => writeBundleInto(sandbox, path, content),
    readTextFile: (path) => readTextFileFrom(sandbox, path),
    browserd: adaptSandbox(sandbox),
    killBrowserd: () => killBrowserdIn(sandbox),
    ensureStream: () => ensureStreamOn(sandbox),
    // `Sandbox.connect` holds no resource to release; never kill the durable
    // computer here.
    disconnect: async () => {},
  };
}

/** Connect via `@e2b/desktop` (the stream API lives on its Sandbox). */
async function connectDesktopSandbox(
  sandboxId: string,
): Promise<ConnectedSandboxLike> {
  const desktop = (await import("@e2b/desktop")) as {
    Sandbox: { connect(id: string): Promise<Sandbox> };
  };
  return (await desktop.Sandbox.connect(
    sandboxId,
  )) as unknown as ConnectedSandboxLike;
}

/** The production deps for `ensureBrowserSession`. */
export function liveBrowserSessionDeps(): BrowserSessionDeps {
  return {
    reserveDesktop: async ({ bearer, projectId, signal }) => {
      const reserved = await ensureComputerReady({
        bearer,
        projectId,
        runtimeKind: "desktop-browser",
        signal,
      });
      if (!reserved.ok) {
        // The STATUS is kept, not folded into a message. Most of these are
        // refusals a person can act on — the plan does not include Computers,
        // the daily start cap is spent, the vendor account is full — and a
        // caller that cannot tell them apart can only say "something went
        // wrong" and page an engineer for a quota working as designed.
        throw new HostedReserveError(
          reserved.error,
          reserved.status,
          reserved.code,
        );
      }
      return { computerId: reserved.value.computerId };
    },
    resolveSandboxId: async (computerId) => {
      const info = await getComputerSandboxInfo({ computerId });
      if (!info.ok) {
        // This call authenticates with the INSPECTOR SERVICE TOKEN, not the
        // member's bearer — so an auth rejection here is our deployment being
        // wrong, never theirs. Classified as a refusal it would reach them as
        // `hosted-auth-required` ("sign in again"), asking them to fix
        // something they cannot see, and would swallow the 500 that pages us
        // about a token that has stopped working. Thrown bare so it lands on
        // the 500-and-report path where it belongs.
        if (info.status === 401 || info.status === 403) {
          throw new Error(
            `sandbox-info rejected the inspector service token (${info.status}): ${info.error}`,
          );
        }
        throw new HostedReserveError(info.error, info.status, info.code);
      }
      if (!info.value.providerComputerId) {
        throw new Error("computer has no vendor sandbox id yet");
      }
      return info.value.providerComputerId;
    },
    connect: async (sandboxId) =>
      connectSessionSandbox(await connectDesktopSandbox(sandboxId)),
    boot: bootBrowserd,
    createClient: (baseUrl, bearer) => new BrowserdClient({ baseUrl, bearer }),
    store: {
      lookup: lookupBrowserSession,
      record: recordBrowserSession,
      touch: touchBrowserSession,
      claimRelaunch: claimBrowserRelaunch,
      releaseRelaunch: releaseBrowserRelaunch,
    },
    touchActivity: (args) => touchComputerActivity(args),
    bundle: loadBrowserdBundle,
    bundleHash: browserdBundleHash,
  };
}

/**
 * Ensure a live HOSTED browser session with the production seams.
 *
 * Narrower than `BrowserSessionHandle` on purpose: this door only ever reaches
 * the E2B desktop, so widening it to the union told every caller to handle a
 * local handle that cannot arrive — and cost the WebMCP inspector, which needs
 * the hosted fields, the type that says so.
 */
// OVERLOADED, so the three computer callers (the WebMCP inspector route, the
// Browser Panel, the hosted session resolver) keep the COMPUTER type and stay
// unedited: they read `computerId` and `streamUrl` straight off the handle,
// and none of them should have to narrow a union to say "yes, the member's own
// machine is the member's own machine".
export function ensureLiveBrowserSession(
  args: EnsureBrowserSessionArgs & { target?: { kind: "computer" } },
): Promise<ComputerHostedBrowserSessionHandle>;
export function ensureLiveBrowserSession(
  args: EnsureBrowserSessionArgs & {
    target: { kind: "sandbox"; sandboxRowId: string; sandboxId: string };
  },
): Promise<SandboxHostedBrowserSessionHandle>;
export function ensureLiveBrowserSession(
  args: EnsureBrowserSessionArgs,
): Promise<HostedBrowserSessionHandle> {
  // Dispatched rather than cast: the two overloads above are the checked
  // surface, and narrowing here is what makes the implementation satisfy both
  // without an `as` that a later edit could quietly widen.
  const { target, ...rest } = args;
  if (target?.kind === "sandbox") {
    return ensureBrowserSession(liveBrowserSessionDeps(), { ...rest, target });
  }
  return ensureBrowserSession(liveBrowserSessionDeps(), {
    ...rest,
    ...(target ? { target } : {}),
  });
}
