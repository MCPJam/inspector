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
import { Sandbox } from "e2b";
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";

export interface E2BSandboxProviderOptions {
  /** E2B template with Node + the claude-agent-sdk available (see README). */
  template?: string;
  /** Reuse an existing E2B sandbox (MCPJam computer) instead of creating one. */
  connectToSandboxId?: string;
  /** Port the in-sandbox bridge binds to; declared via session.ports so the
   *  claude-code adapter picks it up. */
  bridgePort?: number;
  /** E2B default home for a standard template. */
  defaultWorkingDirectory?: string;
  apiKey?: string;
}

const enc = new TextEncoder();

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
      const sandbox = opts.connectToSandboxId
        ? await Sandbox.connect(opts.connectToSandboxId, { apiKey: opts.apiKey })
        : await Sandbox.create(opts.template ?? "base", { apiKey: opts.apiKey });

      let ports: number[] = [bridgePort];

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
          } catch {
            return null; // contract: null when the file is absent
          }
        },
        readBinaryFile: async ({ path }) => {
          try {
            return await sandbox.files.read(path, { format: "bytes" });
          } catch {
            return null;
          }
        },
        readFile: async ({ path }) => {
          try {
            const bytes = await sandbox.files.read(path, { format: "bytes" });
            return bytesToStream(bytes);
          } catch {
            return null;
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
          const res = await sandbox.commands.run(command, {
            cwd: workingDirectory ?? cwd,
            envs: env,
          });
          return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
        },

        // ── spawn (long-lived; adapt E2B callbacks → ReadableStreams) ──────
        spawn: async ({ command, workingDirectory, env }) => {
          let outCtl!: ReadableStreamDefaultController<Uint8Array>;
          let errCtl!: ReadableStreamDefaultController<Uint8Array>;
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
            onStdout: (d: string) => outCtl.enqueue(enc.encode(d)),
            onStderr: (d: string) => errCtl.enqueue(enc.encode(d)),
          });
          return {
            pid: handle.pid,
            stdout,
            stderr,
            wait: async () => {
              const res = await handle.wait();
              outCtl.close();
              errCtl.close();
              return { exitCode: res.exitCode };
            },
            kill: async () => {
              await handle.kill();
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
          await sandbox.kill();
        },
        destroy: async () => {
          await sandbox.kill();
        },
        setPorts: async (next) => {
          ports = [...next];
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
