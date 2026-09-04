/**
 * The W1 internal debug probe: the end-to-end assembly that proves the hosted
 * browser pipeline works — reserve a DESKTOP computer, boot browserd inside it,
 * navigate, and screenshot. This is the orchestration ONLY; the live pieces
 * (Convex reserve/sandbox-info, `Sandbox.connect`, `bootBrowserd`, the real
 * `BrowserdClient`) are injected as seams so the sequence — and, above all, the
 * guaranteed cleanup — is unit-testable without a sandbox or the network.
 *
 * Cleanup is the load-bearing part: a boot that half-succeeds must never leave a
 * daemon running in a durable computer, so the daemon is stopped and the sandbox
 * connection released in a `finally`, on every path.
 */
import { randomUUID } from "node:crypto";
import type {
  BootBrowserdOptions,
  BrowserdHandle,
  BrowserdSandbox,
} from "./boot-browserd";
import type { BrowserdCommandResponse } from "./browserd-client";
import type { BrowserCommand } from "./protocol";

/** The sandbox pieces the probe needs, once connected. */
export interface ProbeSandbox {
  /** Write the daemon bundle into the sandbox filesystem. */
  writeBundle(path: string, content: Uint8Array): Promise<void>;
  /** The daemon runner `bootBrowserd` drives. */
  browserd: BrowserdSandbox;
  /** Release the connection. Never kills the durable computer itself. */
  disconnect(): Promise<void>;
}

/** A `BrowserdClient`, narrowed to what the probe calls (so tests can fake it). */
export interface ProbeClient {
  sendCommand(
    command: BrowserCommand,
    expectedBootId?: string,
  ): Promise<BrowserdCommandResponse>;
}

export interface BrowserProbeDeps {
  /** Reserve/ensure a desktop computer; returns its row id. */
  reserveDesktop(): Promise<{ computerId: string }>;
  /** Exchange a computer id for its vendor sandbox id. */
  resolveSandboxId(computerId: string): Promise<string>;
  /** Connect to the sandbox. */
  connect(sandboxId: string): Promise<ProbeSandbox>;
  /** Boot browserd (the real `bootBrowserd` in production). */
  boot(
    sandbox: BrowserdSandbox,
    options: BootBrowserdOptions,
  ): Promise<BrowserdHandle>;
  /** Build the client for a booted daemon. */
  createClient(baseUrl: string, bearer: string): ProbeClient;
}

export interface BrowserProbeInput {
  /** The URL to navigate to and screenshot. */
  url: string;
  /** The daemon bundle bytes to upload. */
  bundle: Uint8Array;
  /** Where to place the bundle in the sandbox. */
  scriptPath?: string;
  port?: number;
  userDataDir?: string;
}

export interface BrowserProbeResult {
  computerId: string;
  bootId: string;
  url: string;
  settled: boolean;
  /** Size of the returned screenshot (base64 chars) — proof a frame came back. */
  screenshotBytes: number;
}

const DEFAULT_SCRIPT_PATH = "/opt/mcpjam/mcpjam-browserd.mjs";
const DEFAULT_PORT = 8791;
const DEFAULT_USER_DATA_DIR = "/home/user/.mcpjam-browserd";

function inspectorCommand(action: BrowserCommand["action"]): BrowserCommand {
  return { commandId: randomUUID(), source: "inspector", action };
}

/**
 * Run the probe. Throws on any failure — always after tearing down the daemon
 * and releasing the connection.
 */
export async function runBrowserProbe(
  deps: BrowserProbeDeps,
  input: BrowserProbeInput,
): Promise<BrowserProbeResult> {
  const { computerId } = await deps.reserveDesktop();
  const sandboxId = await deps.resolveSandboxId(computerId);
  const sandbox = await deps.connect(sandboxId);

  let handle: BrowserdHandle | undefined;
  try {
    const scriptPath = input.scriptPath ?? DEFAULT_SCRIPT_PATH;
    await sandbox.writeBundle(scriptPath, input.bundle);
    handle = await deps.boot(sandbox.browserd, {
      scriptPath,
      port: input.port ?? DEFAULT_PORT,
      userDataDir: input.userDataDir ?? DEFAULT_USER_DATA_DIR,
    });

    const client = deps.createClient(handle.publicOrigin, handle.bearer);
    const nav = await client.sendCommand(
      inspectorCommand({ kind: "navigate", url: input.url }),
      handle.bootId,
    );
    // Two layers can fail independently: the command can be REJECTED (busy,
    // expired, …) with a non-"ok" transport status, OR it can be admitted
    // (status "ok") but the browser OPERATION itself failed — the queue
    // normalizes a Chromium throw to `result.ok === false`. Both are failures.
    if (nav.status !== "ok") {
      throw new Error(`browserd navigate rejected: ${nav.status}`);
    }
    if (!nav.result.ok) {
      throw new Error(
        `browserd navigate failed: ${nav.result.error ?? "unknown"}`,
      );
    }
    const shot = await client.sendCommand(
      inspectorCommand({ kind: "observe", mode: "screenshot" }),
      handle.bootId,
    );
    if (shot.status !== "ok") {
      throw new Error(`browserd screenshot rejected: ${shot.status}`);
    }
    if (!shot.result.ok) {
      throw new Error(
        `browserd screenshot failed: ${shot.result.error ?? "unknown"}`,
      );
    }

    const screenshot =
      (shot.result.output as { screenshot?: string })?.screenshot ?? "";
    return {
      computerId,
      bootId: handle.bootId,
      url: input.url,
      settled: nav.result.settled ?? false,
      screenshotBytes: screenshot.length,
    };
  } finally {
    // Never leave a daemon running in a durable computer; never kill the box.
    await handle?.stop().catch(() => {});
    await sandbox.disconnect().catch(() => {});
  }
}
