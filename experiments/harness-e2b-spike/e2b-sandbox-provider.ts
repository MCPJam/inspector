/**
 * Phase 0 spike — an E2B-backed `HarnessV1SandboxProvider` for the AI SDK
 * harness. This is the crux of "reuse our E2B setup": it proves (at the type
 * level, and — with creds — at runtime) that E2B can satisfy the same contract
 * the reference `@ai-sdk/sandbox-vercel` provider satisfies.
 *
 * Contract → E2B mapping (the whole reason this is feasible):
 *   file I/O (readTextFile/writeTextFile/…) → sandbox.files.read / .write
 *   exec (run) / spawn                      → sandbox.commands.run (+ background)
 *   getPortUrl({ port })                    → sandbox.getHost(port)   ← the key one
 *   id / defaultWorkingDirectory / ports / stop / destroy → native E2B
 *
 * Reuse path: pass `connectToSandboxId` to attach to an existing E2B sandbox
 * (e.g. MCPJam's per-(project,user) computer resolved via reserve →
 * getComputerSandboxInfo). Omit it and the provider creates a fresh sandbox.
 *
 * NOT run in this environment (no E2B_API_KEY) — written against the real
 * canary `@ai-sdk/harness` types and validated with `tsc`.
 */
import { Sandbox, FileNotFoundError, CommandExitError } from "e2b";
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";

export interface E2BSandboxProviderOptions {
  /** E2B template with Node + the claude-agent-sdk available (see README).
   *  MCPJam's computer template is `ciq83q75k6orlaznpxo7` (ships Node 20). */
  template?: string;
  /** Reuse an existing E2B sandbox (MCPJam computer) instead of creating one.
   *  The box must already be AWAKE — wake a hibernated computer via the control
   *  plane (getOrReserveComputer) first; Sandbox.connect won't resume it. */
  connectToSandboxId?: string;
  /** Mirror prod, which provisions every computer with `secure: true`. */
  secure?: boolean;
  /** Keep the box alive long enough for the harness run. */
  timeoutMs?: number;
  /** Port the in-sandbox bridge binds to; declared via session.ports so the
   *  claude-code adapter picks it up. */
  bridgePort?: number;
  /** E2B default home for a standard template. */
  defaultWorkingDirectory?: string;
  apiKey?: string;
}

const enc = new TextEncoder();

/** E2B throws FileNotFoundError for a missing path; the SandboxSession contract
 *  wants `null` there, but real failures (transport / permission / sandbox-gone)
 *  must propagate rather than masquerade as "file absent". */
function nullIfMissing(err: unknown): null {
  if (err instanceof FileNotFoundError) return null;
  throw err;
}

/** E2B's files.write `data` accepts string | ArrayBuffer | Blob | ReadableStream
 *  (not a Uint8Array view), so hand it a clean, exactly-sized ArrayBuffer. */
function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.slice().buffer as ArrayBuffer;
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

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

export function createE2BSandboxProvider(
  opts: E2BSandboxProviderOptions = {},
): HarnessV1SandboxProvider {
  const bridgePort = opts.bridgePort ?? 39271;
  const cwd = opts.defaultWorkingDirectory ?? "/home/user";

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "mcpjam-e2b",
    // Single-port pool — the bridge leases this one port. (E2B's getHost works
    // for any listening port regardless, but the adapter reads `ports`.)
    bridgePorts: [bridgePort],

    createSession: async (createOpts) => {
      const abortSignal = createOpts?.abortSignal;
      // Only sandboxes WE create are ours to tear down. A reused MCPJam
      // computer (connectToSandboxId) is shared and lifecycle-managed by the
      // control plane, so a harness session ending must never kill it.
      const ownsSandbox = !opts.connectToSandboxId;
      const sandbox = opts.connectToSandboxId
        ? // Reuse path: box must already be awake (control plane wakes it). For
          // `secure: true` boxes the SDK resolves the per-sandbox envd token
          // from the org apiKey on connect — TEST 1 confirms that holds.
          await Sandbox.connect(opts.connectToSandboxId, {
            apiKey: opts.apiKey,
            timeoutMs: opts.timeoutMs,
          })
        : // Spike-owned box: mirror prod's `secure: true`. create() returns an
          // already-tokened, connected instance, so getHost works without extra
          // wiring. Flip SPIKE_E2B_SECURE=false to isolate harness vs secure-URL.
          await Sandbox.create(opts.template ?? "base", {
            apiKey: opts.apiKey,
            secure: opts.secure ?? true,
            timeoutMs: opts.timeoutMs,
          });

      // Mutated in place by setPorts so `session.ports` (same ref) stays live.
      const ports: number[] = [bridgePort];

      // The @ai-sdk/harness-claude-code bootstrap shells `pnpm install` BEFORE
      // onSandboxSession runs, and MCPJam's computer template ships Node + npm
      // but not pnpm — provision it now (idempotent; the writable
      // /opt/npm-global prefix means `-g` needs no sudo). Real fix: bake pnpm
      // into templates/computer/e2b.Dockerfile so this no-ops.
      //
      // If this throws, the caller never receives a session to tear down, so a
      // box WE created would leak until its E2B timeout — kill an owned box
      // before rethrowing. A reused (shared) box is the control plane's to
      // manage, so never kill it here.
      try {
        await sandbox.commands.run("command -v pnpm || npm install -g pnpm");
      } catch (err) {
        if (ownsSandbox) {
          try {
            await sandbox.kill();
          } catch {
            /* best effort — surface the original setup error, not a kill error */
          }
        }
        throw err;
      }

      const session: HarnessV1NetworkSandboxSession = {
        id: sandbox.sandboxId,
        defaultWorkingDirectory: cwd,
        description:
          `E2B sandbox ${sandbox.sandboxId}. Working dir ${cwd}. ` +
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
            });
            return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
          } catch (err) {
            // E2B throws on non-zero exit; the contract wants the result
            // (exitCode + streams) surfaced, not a rejection.
            if (err instanceof CommandExitError) {
              return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
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
            try { outCtl.close(); } catch { /* already closed */ }
            try { errCtl.close(); } catch { /* already closed */ }
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
            // Guard against enqueue-after-close once the process ends or is killed.
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
              if (err instanceof CommandExitError) return { exitCode: err.exitCode };
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
          const scheme = protocol === "ws" ? "wss" : protocol ?? "https";
          return `${scheme}://${host}`;
        },
        stop: async () => {
          // Never tear down a reused (shared) computer; only one we created.
          if (ownsSandbox) await sandbox.kill();
        },
        destroy: ownsSandbox
          ? async () => {
              await sandbox.kill();
            }
          : undefined,
        setPorts: async (next) => {
          // Mutate in place so `session.ports` (same reference) reflects it.
          ports.splice(0, ports.length, ...next);
        },
        // setNetworkPolicy omitted — E2B sets egress at create time; the
        // optional-call contract treats a missing impl as a no-op.

        restricted: () => session, // same resource, narrower static type
      };

      void abortSignal; // create() doesn't take a signal in this spike
      return session;
    },
  };
}
