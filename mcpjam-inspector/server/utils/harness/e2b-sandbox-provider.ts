/**
 * E2B-backed `HarnessV1SandboxProvider` for running the AI SDK **Claude Code
 * harness** inside a host's existing MCPJam computer (an E2B sandbox).
 *
 * This is the production promotion of the Phase 0 spike. The defining
 * difference from the spike: it ONLY ever attaches to an already-provisioned,
 * already-awake sandbox (resolved via the control plane — see
 * `resolve-sandbox.ts`). It NEVER creates or tears down a box. A host's
 * computer is a shared, long-lived resource whose lifecycle (provision / wake /
 * hibernate / delete) is owned entirely by the Convex control plane, so a
 * harness session ending must leave the computer running.
 *
 * Contract → E2B mapping (the whole reason reuse is feasible):
 *   file I/O (readTextFile/writeTextFile/…) → sandbox.files.read / .write
 *   exec (run) / spawn                      → sandbox.commands.run (+ background)
 *   getPortUrl({ port })                    → sandbox.getHost(port)   ← bridge
 *   id / defaultWorkingDirectory / ports    → native E2B
 *   stop / destroy                          → no-op (control plane owns teardown)
 */
import { Sandbox, FileNotFoundError, CommandExitError } from "e2b";
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";

export interface E2BHarnessSandboxProviderOptions {
  /** E2B sandbox id of the host's computer — resolved via the control plane
   *  (`ensureComputerReady` → `getComputerSandboxInfo.providerComputerId`, see
   *  `resolve-sandbox.ts`). The box must already be AWAKE: `ensureComputerReady`
   *  wakes it; `Sandbox.connect` will not resume a hibernated box on its own. */
  sandboxId: string;
  /** E2B API key. Defaults to the `E2B_API_KEY` env the data plane already
   *  holds (same as `server/utils/computers/run-command.ts`). */
  apiKey?: string;
  /** Working dir inside the sandbox. E2B's default home for the computer
   *  template. */
  defaultWorkingDirectory?: string;
  /** Port the in-sandbox Claude Code bridge binds to; surfaced via
   *  `session.ports` so the claude-code adapter picks it up. E2B's `getHost`
   *  bridges any listening port, but the adapter reads `ports`. */
  bridgePort?: number;
  /** Connect/keep-alive timeout handed to `Sandbox.connect`. */
  connectTimeoutMs?: number;
  /** Per-command exec timeout for `run`. E2B foreground commands default to
   *  ~60s — too short for the harness bootstrap (`pnpm install`) on a larger
   *  dep tree. Background `spawn` is not subject to the foreground cap. */
  commandTimeoutMs?: number;
}

const enc = new TextEncoder();

/** E2B throws `FileNotFoundError` for a missing path; the SandboxSession
 *  contract wants `null` there, but real failures (transport / permission /
 *  sandbox-gone) must propagate rather than masquerade as "file absent". */
function nullIfMissing(err: unknown): null {
  if (err instanceof FileNotFoundError) return null;
  throw err;
}

/** E2B's `files.write` `data` accepts string | ArrayBuffer | Blob |
 *  ReadableStream (not a Uint8Array view), so copy into a fresh, exactly-sized
 *  ArrayBuffer. We must NOT return `u8.slice().buffer`: when `u8` is a Node
 *  `Buffer` (a Uint8Array subclass), `Buffer.prototype.slice` returns a *view*
 *  that shares the pooled backing store rather than a copy, so `.buffer` would
 *  expose the whole (often 8 KiB) allocation pool — writing unrelated adjacent
 *  bytes into the sandbox file. Allocating exactly `byteLength` and `.set()`ing
 *  respects the source's byteOffset/length for both Buffers and subarray views. */
function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

/** One-chunk ReadableStream from already-materialized bytes. */
function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streamToBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function createE2BHarnessSandboxProvider(
  opts: E2BHarnessSandboxProviderOptions,
): HarnessV1SandboxProvider {
  const bridgePort = opts.bridgePort ?? 39271;
  const cwd = opts.defaultWorkingDirectory ?? "/home/user";
  // E2B foreground `commands.run` defaults to a ~60s command timeout, separate
  // from the sandbox's own lifetime — too short for the harness bootstrap
  // (`pnpm install`). Background `spawn` is not subject to this cap.
  const commandTimeoutMs = opts.commandTimeoutMs ?? 10 * 60_000;

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "mcpjam-e2b",
    // Single-port pool — the bridge leases this one port.
    bridgePorts: [bridgePort],

    createSession: async () => {
      // Reuse the host's existing computer. It must already be awake — the
      // caller wakes it via the control plane (`ensureComputerReady`) before
      // resolving the sandboxId. We never create or kill a box here.
      const sandbox = await Sandbox.connect(opts.sandboxId, {
        apiKey: opts.apiKey,
        timeoutMs: opts.connectTimeoutMs,
      });

      // Mutated in place by setPorts so `session.ports` (same ref) stays live.
      const ports: number[] = [bridgePort];

      // The @ai-sdk/harness-claude-code bootstrap shells `pnpm install` BEFORE
      // any session hook runs. pnpm is baked into the computer template
      // (mcpjam-backend templates/computer/e2b.Dockerfile); this idempotent
      // guard is a stopgap for boxes provisioned before that template rebuild
      // lands, and no-ops once pnpm is present. We do not own the box, so a
      // failure here propagates (the control plane still owns teardown).
      await sandbox.commands.run("command -v pnpm || npm install -g pnpm", {
        timeoutMs: commandTimeoutMs,
      });

      const session: HarnessV1NetworkSandboxSession = {
        id: sandbox.sandboxId,
        defaultWorkingDirectory: cwd,
        description:
          `E2B sandbox ${sandbox.sandboxId} (host computer). Working dir ${cwd}. ` +
          `Bridge port ${bridgePort} reachable at ${sandbox.getHost(bridgePort)}.`,

        // ── file I/O ──────────────────────────────────────────────────────
        readTextFile: async ({ path }) => {
          try {
            return await sandbox.files.read(path);
          } catch (err) {
            return nullIfMissing(err); // null only for a genuinely missing file
          }
        },
        readBinaryFile: async ({ path }) => {
          try {
            return await sandbox.files.read(path, { format: "bytes" });
          } catch (err) {
            return nullIfMissing(err);
          }
        },
        readFile: async ({ path }) => {
          try {
            const bytes = await sandbox.files.read(path, { format: "bytes" });
            return bytesToStream(bytes);
          } catch (err) {
            return nullIfMissing(err);
          }
        },
        writeTextFile: async ({ path, content }) => {
          await sandbox.files.write([{ path, data: content }]);
        },
        writeBinaryFile: async ({ path, content }) => {
          await sandbox.files.write([{ path, data: u8ToArrayBuffer(content) }]);
        },
        writeFile: async ({ path, content }) => {
          const bytes = await streamToBytes(content);
          await sandbox.files.write([{ path, data: u8ToArrayBuffer(bytes) }]);
        },

        // ── exec ──────────────────────────────────────────────────────────
        run: async ({ command, workingDirectory, env }) => {
          try {
            const res = await sandbox.commands.run(command, {
              cwd: workingDirectory ?? cwd,
              envs: env,
              timeoutMs: commandTimeoutMs,
            });
            return {
              exitCode: res.exitCode,
              stdout: res.stdout,
              stderr: res.stderr,
            };
          } catch (err) {
            // E2B throws on non-zero exit; the contract wants the result
            // (exitCode + streams) surfaced, not a rejection.
            if (err instanceof CommandExitError) {
              return {
                exitCode: err.exitCode,
                stdout: err.stdout,
                stderr: err.stderr,
              };
            }
            throw err;
          }
        },

        // ── spawn (long-lived; adapt E2B callbacks → ReadableStreams) ──────
        spawn: async ({ command, workingDirectory, env }) => {
          let outCtl!: ReadableStreamDefaultController<Uint8Array>;
          let errCtl!: ReadableStreamDefaultController<Uint8Array>;
          let streamsClosed = false;
          const closeStreams = () => {
            if (streamsClosed) return;
            streamsClosed = true;
            try {
              outCtl.close();
            } catch {
              /* already closed */
            }
            try {
              errCtl.close();
            } catch {
              /* already closed */
            }
          };
          const stdout = new ReadableStream<Uint8Array>({
            start: (c) => (outCtl = c),
          });
          const stderr = new ReadableStream<Uint8Array>({
            start: (c) => (errCtl = c),
          });
          const handle = await sandbox.commands.run(command, {
            background: true,
            cwd: workingDirectory ?? cwd,
            envs: env,
            // Guard against enqueue-after-close once the process ends/is killed.
            onStdout: (d: string) => {
              if (!streamsClosed) outCtl.enqueue(enc.encode(d));
            },
            onStderr: (d: string) => {
              if (!streamsClosed) errCtl.enqueue(enc.encode(d));
            },
          });
          // Observe exit exactly once; normalize E2B's throw-on-nonzero into an
          // exit code so wait() resolves (contract) instead of rejecting.
          const exitPromise: Promise<{ exitCode: number }> = handle
            .wait()
            .then((r) => ({ exitCode: r.exitCode }))
            .catch((err) => {
              if (err instanceof CommandExitError) {
                return { exitCode: err.exitCode };
              }
              throw err;
            });
          // Close streams when the process ends on its OWN — not only via
          // wait()/kill() — so a consumer reading to EOF never hangs.
          void exitPromise.then(closeStreams, closeStreams);
          return {
            pid: handle.pid,
            stdout,
            stderr,
            wait: async () => {
              try {
                return await exitPromise;
              } finally {
                closeStreams();
              }
            },
            kill: async () => {
              try {
                await handle.kill();
              } finally {
                closeStreams(); // parity with wait; never leave readers hanging
              }
            },
          };
        },

        // ── infra surface ─────────────────────────────────────────────────
        ports,
        getPortUrl: async ({ port, protocol }) => {
          const host = sandbox.getHost(port);
          const scheme = protocol === "ws" ? "wss" : (protocol ?? "https");
          return `${scheme}://${host}`;
        },
        // Never tear down a shared host computer: the control plane owns its
        // lifecycle (provision / wake / hibernate / delete). Ending a harness
        // session leaves the box running. The harness cleans up its own bridge
        // process via the spawn handle's kill(), not via the sandbox.
        stop: async () => {
          /* no-op — control-plane-owned box */
        },
        // destroy intentionally omitted (undefined) for the same reason.
        setPorts: async (next) => {
          // Mutate in place so `session.ports` (same reference) reflects it.
          ports.splice(0, ports.length, ...next);
        },
        // setNetworkPolicy omitted — E2B sets egress at create time; the
        // optional-call contract treats a missing impl as a no-op.

        restricted: () => session, // same resource, narrower static type
      };

      return session;
    },
  };
}
