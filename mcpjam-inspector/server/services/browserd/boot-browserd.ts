/**
 * Boot mcpjam-browserd inside a provisioned desktop sandbox.
 *
 * This is the inspector-SERVER side (it drives the sandbox); it is deliberately
 * OUTSIDE `daemon/`, so it is never pulled into the bundled daemon artifact. It
 * mirrors the plugin-box shim boot (`server/utils/computers/plugin-box.ts`):
 * start the daemon in the BACKGROUND with a command that never times out, pass
 * secrets in `envs` (never argv — visible to every process in the box and the
 * vendor command log), block on the one stdout ready-line, and reap the process
 * on any unsuccessful start so a durable computer never accumulates orphaned
 * daemons.
 *
 * What it adds over the shim boot: it mints the per-boot bearer the inspector
 * will use to authenticate its own requests to browserd (browserd self-auths
 * every request because each getHost port is public), and it captures the
 * daemon's `bootId` from the ready-line — the inspector stores it so a command
 * replayed against a different boot is rejected rather than re-run.
 */
import { randomBytes } from "node:crypto";

/** The minimal sandbox surface the boot needs; the debug route adapts a real
 *  E2B box to this, tests provide a fake. */
export interface BrowserdSandbox {
  /**
   * Start a long-lived background process. Resolves once the process is
   * launched (NOT once it exits) with handles to reap it and to await its exit.
   */
  runBackground(
    command: string,
    options: {
      envs: Record<string, string>;
      onStdout: (chunk: string) => void;
    },
  ): Promise<{ kill: () => Promise<unknown>; wait: () => Promise<unknown> }>;
  /** The public HTTPS host for a sandbox port. */
  getHost(port: number): string;
}

export interface BootBrowserdOptions {
  /** Absolute path to the bundled daemon inside the sandbox. */
  scriptPath: string;
  port: number;
  userDataDir: string;
  /** `--window-size` matched to the X screen geometry, if known. */
  windowSize?: string;
  headless?: boolean;
  readyTimeoutMs?: number;
  /**
   * `ephemeral` boots the daemon with NO persistent profile, so an eval or
   * swarm iteration cannot inherit the previous one's cookies. Defaults to
   * the persistent profile a playground login depends on.
   */
  contextMode?: "persistent" | "ephemeral";
}

export interface BrowserdHandle {
  /** The per-boot bearer the inspector presents on every browserd request. */
  bearer: string;
  /** The daemon's boot nonce, echoed on every response (idempotency guard). */
  bootId: string;
  port: number;
  /** `https://<getHost(port)>` — where the inspector reaches browserd. */
  publicOrigin: string;
  /** Reap the daemon. Idempotent and never throws. */
  stop: () => Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

interface BrowserdReadyLine {
  port: number;
  bootId: string;
}

function parseReadyLine(line: string): BrowserdReadyLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.event !== "listening") return null;
  if (typeof record.port !== "number") return null;
  if (typeof record.bootId !== "string" || record.bootId.length === 0)
    return null;
  return { port: record.port, bootId: record.bootId };
}

function buildEnv(
  bearer: string,
  options: BootBrowserdOptions,
): Record<string, string> {
  const env: Record<string, string> = {
    MCPJAM_BROWSERD_TOKEN: bearer,
    MCPJAM_BROWSERD_PORT: String(options.port),
    MCPJAM_BROWSERD_USER_DATA_DIR: options.userDataDir,
  };
  if (options.windowSize) env.MCPJAM_BROWSERD_WINDOW_SIZE = options.windowSize;
  if (options.headless) env.MCPJAM_BROWSERD_HEADLESS = "true";
  if (options.contextMode === "ephemeral") {
    env.MCPJAM_BROWSERD_EPHEMERAL = "true";
  }
  return env;
}

/**
 * Start browserd in `sandbox` and resolve once it reports listening. Rejects —
 * after reaping the process — if the daemon exits before listening or does not
 * report within `readyTimeoutMs`. The kill/finish choreography mirrors the shim
 * boot exactly: the ready line can arrive on `onStdout` before the run promise
 * resolves, so success is detected there and the run promise only reaps on a
 * FAILED start (`failed`, not `settled`).
 */
export function bootBrowserd(
  sandbox: BrowserdSandbox,
  options: BootBrowserdOptions,
): Promise<BrowserdHandle> {
  const bearer = randomBytes(32).toString("hex");
  const env = buildEnv(bearer, options);
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  return new Promise<BrowserdHandle>((resolve, reject) => {
    let settled = false;
    let failed = false;
    let carry = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started: { kill: () => Promise<unknown> } | undefined;

    const kill = async (): Promise<void> => {
      try {
        await started?.kill();
      } catch {
        // Already gone or the box is unreachable — nothing further to do.
      }
    };

    const finish = (outcome: BrowserdReadyLine | Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (outcome instanceof Error) {
        failed = true;
        void kill(); // never leave an orphan daemon in a durable computer
        reject(outcome);
        return;
      }
      resolve({
        bearer,
        bootId: outcome.bootId,
        port: outcome.port,
        publicOrigin: `https://${sandbox.getHost(outcome.port)}`,
        stop: kill,
      });
    };

    void sandbox
      .runBackground(`node ${JSON.stringify(options.scriptPath)}`, {
        envs: env,
        onStdout: (chunk) => {
          if (settled) return;
          carry += chunk;
          let index: number;
          while ((index = carry.indexOf("\n")) >= 0) {
            const line = carry.slice(0, index);
            carry = carry.slice(index + 1);
            const ready = parseReadyLine(line);
            if (ready) finish(ready);
          }
        },
      })
      .then((command) => {
        started = command;
        // The deadline may have fired before the handle existed; reap here.
        // Gated on `failed`, not `settled` — a success commonly settles from
        // onStdout before this resolves.
        if (failed) {
          void kill();
          return;
        }
        void command
          .wait()
          .then(() =>
            finish(new Error("browserd exited before it reported listening")),
          )
          .catch((error) =>
            finish(
              new Error(
                `browserd exited before it reported listening (${
                  error instanceof Error ? error.message : "unknown"
                })`,
              ),
            ),
          );
      })
      .catch((error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );

    timer = setTimeout(
      () =>
        finish(
          new Error(
            `browserd did not report listening within ${readyTimeoutMs}ms`,
          ),
        ),
      readyTimeoutMs,
    );
    // A synchronous ready line settles before the timer exists; clear it.
    if (settled) clearTimeout(timer);
  });
}
