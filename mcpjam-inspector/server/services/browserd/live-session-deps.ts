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
import {
  ensureComputerReady,
  getComputerSandboxInfo,
} from "../../utils/computers/control-plane-client.js";
import { bootBrowserd, type BrowserdSandbox } from "./boot-browserd.js";
import { BrowserdClient } from "./browserd-client.js";
import {
  lookupBrowserSession,
  recordBrowserSession,
  touchBrowserSession,
} from "./browser-sessions-client.js";
import {
  ensureBrowserSession,
  type BrowserSessionDeps,
  type BrowserSessionHandle,
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
    getHost: (port) => sandbox.getHost(port),
  };
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
 * Ensure the desktop stream is up with auth required and return its URL +
 * minted password. `MCPJAM_BROWSER_STREAM_DISABLED=1` is a staging bring-up
 * hatch: it records a well-formed but deliberately unusable stream so the
 * command path can be validated before the stream seam is.
 */
async function ensureStreamOn(
  sandbox: unknown,
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
    // An already-running stream is fine — its auth key is still readable.
    // Anything else is a real failure the caller must surface.
    const message = error instanceof Error ? error.message : String(error);
    if (!/already/i.test(message)) throw error;
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
        throw new Error(
          `desktop reserve failed (${reserved.status}): ${reserved.error}`,
        );
      }
      return { computerId: reserved.value.computerId };
    },
    resolveSandboxId: async (computerId) => {
      const info = await getComputerSandboxInfo({ computerId });
      if (!info.ok) {
        throw new Error(
          `sandbox-info failed (${info.status}): ${info.error}`,
        );
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
    },
    bundle: loadBrowserdBundle,
    bundleHash: browserdBundleHash,
  };
}

/** Ensure a live browser session with the production seams. */
export function ensureLiveBrowserSession(
  args: EnsureBrowserSessionArgs,
): Promise<BrowserSessionHandle> {
  return ensureBrowserSession(liveBrowserSessionDeps(), args);
}
