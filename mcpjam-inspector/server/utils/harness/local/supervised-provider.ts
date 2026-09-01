/**
 * `SupervisedLocalHarnessProvider` — the AI SDK sandbox contract, implemented
 * over a supervised host process instead of a sandbox.
 *
 * ── The name is not the guarantee ────────────────────────────────────────
 * The interface is called `HarnessV1SandboxProvider` and its session type is
 * called `HarnessV1NetworkSandboxSession`. Implementing them does not make a
 * host process a sandbox, and nothing in this file may be read as claiming it
 * does. What the contract actually asks for is file I/O, exec, spawn, and a
 * port URL; all four have honest local implementations, and this provider
 * gives them:
 *
 *   readTextFile / writeFile / …  → node:fs, confined to the granted roots
 *   run / spawn                   → the pinned adapter command grammar,
 *                                   translated to structured operations and
 *                                   handed to `LocalHarnessSupervisor`
 *   getPortUrl                    → a loopback authority, never a LAN one
 *   stop / destroy                → whole-tree termination through the
 *                                   supervisor
 *   setNetworkPolicy              → OMITTED, because there is nothing to
 *                                   enforce it with
 *
 * That last omission is deliberate and load-bearing. The contract treats a
 * missing optional method as a no-op, so implementing it as an empty function
 * would let a caller believe it had applied a network policy that does not
 * exist. An isolated provider implements it when its backend really enforces
 * it; a native one must not.
 *
 * ── The filesystem confinement is about our API, not the machine ─────────
 * `confinePath` keeps Inspector's file methods inside the workspace grant and
 * the session state directory. That matters: those methods are reachable from
 * adapter code and, through it, from model-influenced input. It does NOT
 * confine the vendor process, which runs as the OS user. Both facts must
 * survive into product copy.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import { logger } from "../../logger.js";
import { localHarnessStateRoot } from "./grants.js";
import { assertBridgeLoopbackOnly, localBridgeUrl } from "./bridge-endpoint.js";
import { confinePath } from "./confine.js";
import {
  translateAdapterCommand,
  type CommandTranslationContext,
  type TranslatedCommand,
} from "./command-translation.js";
import type { LocalHarnessCompatibility } from "./compatibility.js";
import type { NodeLauncher } from "./node-launcher.js";
import { revalidateRuntime, type ResolvedRuntime } from "./runtime-identity.js";
import {
  buildLocalHarnessEnv,
  filterBridgeSuppliedEnv,
  syntheticHomeDirectories,
} from "./session-env.js";
import type { LocalHarnessSupervisor } from "./supervisor.js";
import type { SupportedLocalHarnessId } from "./targets.js";

const encoder = new TextEncoder();

export interface SupervisedLocalHarnessProviderOptions {
  harnessId: SupportedLocalHarnessId;
  manifest: LocalHarnessCompatibility;
  runtime: ResolvedRuntime;
  supervisor: LocalHarnessSupervisor;
  launcher: NodeLauncher;
  /** Canonical workspace path resolved from the workspace grant. */
  workspacePath: string;
  workspaceGrantId: string;
  /** Owner-only per-session directory holding the synthetic home, bridge
   *  state, and every other disposable artefact. */
  sessionStateDir: string;
  targetKind: "local-native" | "local-isolated";
  /** Port the bridge binds. Leased by the caller, one per session. */
  bridgePort: number;
  /**
   * Scoped values the child genuinely needs — the model gateway base URL and
   * its per-session capability. Supplied by the parent-side broker.
   *
   * The provider does not read credentials from anywhere else, and never logs
   * these values. Environment delivery is the fallback shape; a vendor that
   * accepts a private config file should be given one instead.
   */
  scopedEnv?: Readonly<Record<string, string>>;
  /** How long to wait for the bridge to start listening on loopback before
   *  giving up on verifying its binding. */
  bridgeReadinessTimeoutMs?: number;
  /** Called once the bridge is up AND its binding has been verified. */
  onBridgeStarted?: (args: { pid: number; port: number }) => Promise<void>;
}

/** The `SandboxProcess` shape, synthesized for translations that need no
 *  process at all (`mkdir`, the `$HOME` reply, a bundle-satisfied no-op). */
function completedProcess(stdout: string, exitCode = 0) {
  const make = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text.length > 0) controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  return {
    pid: undefined as number | undefined,
    stdout: make(stdout),
    stderr: make(""),
    wait: async () => ({ exitCode }),
    kill: async () => {},
  };
}

/**
 * Collect a byte stream into bytes.
 *
 * The binary primitive, kept separate from the text one on purpose: decoding
 * to a string and writing that back out replaces every byte sequence that is
 * not valid UTF-8 with U+FFFD, so an image, an archive, or a compiled artifact
 * written through `writeFile` would land on disk corrupted.
 */
async function collectStreamBytes(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error("aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Text view of a byte stream — for process output, never for file content. */
async function collectStream(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  return new TextDecoder().decode(await collectStreamBytes(stream));
}

export function createSupervisedLocalHarnessProvider(
  opts: SupervisedLocalHarnessProviderOptions
): HarnessV1SandboxProvider {
  const syntheticHome = join(opts.sessionStateDir, "home");

  const buildSession = async (
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<HarnessV1NetworkSandboxSession> => {
    // Session state first: the synthetic home must exist before a vendor CLI's
    // first write, and it must be owner-only from the moment it exists rather
    // than tightened afterwards.
    for (const dir of syntheticHomeDirectories(syntheticHome)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }

    // The two roots the Inspector file API will touch, and nothing else.
    const roots = [opts.sessionStateDir, opts.workspacePath];
    const confine = (path: string) => confinePath(path, { roots });

    const env = {
      ...buildLocalHarnessEnv({
        syntheticHome,
        sessionRoot: opts.workspacePath,
        ...(opts.scopedEnv ? { scoped: opts.scopedEnv } : {}),
      }),
      ...opts.launcher.requiredEnv,
    };

    const translationContext: CommandTranslationContext = {
      harnessId: opts.harnessId,
      adapterBootstrapDir: opts.manifest.adapterBootstrapDir,
      managedBundleRoot: opts.runtime.rootPath,
      nodeExecutable: opts.launcher.executable,
      sessionRoot: opts.workspacePath,
      syntheticHome,
      // The same symlink-aware check the file API uses. The translator awaits
      // it for every session-scoped operand, including the bridge's own
      // `--workdir` and `--bridge-state-dir`, which nothing downstream would
      // otherwise check: they are consumed by the child, not by a filesystem
      // call we make.
      confine,
    };

    // Mutated IN PLACE by setPorts. Rebinding a fresh array would leave
    // `session.ports` — which holds this same reference — pointing at the old
    // lease list, so a consumer would read stale ports while `getPortUrl`
    // honoured the new ones.
    const ports: number[] = [opts.bridgePort];
    // Claimed synchronously, so two concurrent spawns cannot both register as
    // the session root and have the second overwrite the first's durable
    // record (the registry keys by session id).
    let bridgeClaimed = false;

    /**
     * Prove the runtime is still what consent named, immediately before every
     * launch.
     *
     * Availability checked it once, but a session outlives that check: a
     * bundle replaced in between would otherwise be launched here under a
     * grant that describes different bytes. Invariant 3 says "verified before
     * consent AND re-verified before spawn", and spawn is here.
     */
    const assertRuntimeUnchanged = async (): Promise<void> => {
      const result = await revalidateRuntime(opts.runtime);
      if (!result.ok) {
        throw new Error(
          `refusing to launch: ${result.message}. Local execution is bound to ` +
            `a runtime identity, so a changed runtime needs fresh consent.`
        );
      }
    };

    /** Session environment plus the adapter's allowlisted per-call additions. */
    const envFor = (
      supplied: Readonly<Record<string, string>> | undefined
    ): Record<string, string> => ({ ...env, ...filterBridgeSuppliedEnv(supplied) });

    const runTranslated = async (
      translated: TranslatedCommand,
      abort?: AbortSignal,
      suppliedEnv?: Readonly<Record<string, string>>
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      switch (translated.kind) {
        case "reply":
          return { exitCode: 0, stdout: translated.stdout, stderr: "" };
        case "noop":
          logger.debug("[local-harness] adapter command satisfied by bundle", {
            reason: translated.reason,
          });
          return { exitCode: 0, stdout: "", stderr: "" };
        case "mkdir": {
          for (const path of translated.paths) {
            await mkdir(path, { recursive: true, mode: 0o700 });
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        case "exec": {
          await assertRuntimeUnchanged();
          const handle = await opts.supervisor.spawnSupervised({
            sessionId,
            executable: translated.executable,
            args: translated.args,
            workingDirectory: translated.workingDirectory,
            env: envFor(suppliedEnv),
            runtimeId: opts.runtime.runtimeId,
            workspaceGrantId: opts.workspaceGrantId,
            targetKind: opts.targetKind,
            sessionStateDir: opts.sessionStateDir,
            role: "helper",
            ...(abort ? { abortSignal: abort } : {}),
          });
          const [stdout, stderr, result] = await Promise.all([
            collectStream(handle.stdout),
            collectStream(handle.stderr),
            handle.wait(),
          ]);
          return { exitCode: result.exitCode, stdout, stderr };
        }
      }
    };

    const session: HarnessV1NetworkSandboxSession = {
      id: sessionId,
      // The granted workspace is the session's root. The harness framework
      // nests `<workspace>/<harnessId>-<sessionId>` beneath it, which is where
      // the agent actually works — the same shape as the hosted path, so a
      // session's artefacts stay identifiable inside the user's own checkout.
      // Staged materialization with diff-based apply-back is a separate step
      // and is not pretended here.
      defaultWorkingDirectory: opts.workspacePath,
      description:
        `Supervised local ${opts.harnessId} process on this machine. ` +
        `Working directory ${opts.workspacePath}. Bridge on loopback port ` +
        `${opts.bridgePort}. This is NOT an isolated sandbox: the process runs ` +
        `with this operating-system user's authority, narrowed only by the ` +
        `harness's own permission settings.`,

      // ── file I/O (confined to the granted roots) ──────────────────────
      readTextFile: async ({ path, abortSignal: _s, encoding, startLine, endLine }) => {
        const canonical = await confine(path);
        let text: string;
        try {
          text = await readFile(canonical, {
            encoding: (encoding as BufferEncoding | undefined) ?? "utf8",
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
        if (startLine === undefined && endLine === undefined) return text;
        const lines = text.split("\n");
        const from = Math.max((startLine ?? 1) - 1, 0);
        const to = endLine === undefined ? lines.length : Math.min(endLine, lines.length);
        return lines.slice(from, to).join("\n");
      },
      readBinaryFile: async ({ path }) => {
        const canonical = await confine(path);
        try {
          return new Uint8Array(await readFile(canonical));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      readFile: async ({ path }) => {
        const canonical = await confine(path);
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await readFile(canonical));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      },
      writeTextFile: async ({ path, content, encoding }) => {
        const canonical = await confine(path);
        await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
        await writeFile(canonical, content, {
          encoding: (encoding as BufferEncoding | undefined) ?? "utf8",
          mode: 0o600,
        });
      },
      writeBinaryFile: async ({ path, content }) => {
        const canonical = await confine(path);
        await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
        await writeFile(canonical, content, { mode: 0o600 });
      },
      writeFile: async ({ path, content, abortSignal: signal }) => {
        const canonical = await confine(path);
        await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
        // Bytes, not text: this is the contract's binary write primitive.
        const bytes = await collectStreamBytes(content, signal ?? abortSignal);
        await writeFile(canonical, bytes, { mode: 0o600 });
      },

      // ── exec ──────────────────────────────────────────────────────────
      run: async ({ command, abortSignal: signal, env: suppliedEnv }) => {
        const translated = await translateAdapterCommand(
          command,
          translationContext
        );
        return runTranslated(translated, signal ?? abortSignal, suppliedEnv);
      },

      spawn: async ({ command, abortSignal: signal, env: suppliedEnv }) => {
        const translated = await translateAdapterCommand(
          command,
          translationContext
        );
        if (translated.kind !== "exec") {
          // The adapters only ever `spawn` the bridge, but the contract allows
          // any command here; a non-exec translation is satisfied immediately
          // rather than being quietly upgraded into a process.
          const result = await runTranslated(
            translated,
            signal ?? abortSignal,
            suppliedEnv
          );
          return completedProcess(result.stdout, result.exitCode);
        }
        const isBridge = !bridgeClaimed;
        if (isBridge) bridgeClaimed = true;
        await assertRuntimeUnchanged();
        const handle = await opts.supervisor.spawnSupervised({
          sessionId,
          executable: translated.executable,
          args: translated.args,
          workingDirectory: translated.workingDirectory,
          env: envFor(suppliedEnv),
          runtimeId: opts.runtime.runtimeId,
          workspaceGrantId: opts.workspaceGrantId,
          targetKind: opts.targetKind,
          sessionStateDir: opts.sessionStateDir,
          // The first spawned process is the session's root: killing it must
          // take the whole tree, and it is the record the janitor reclaims.
          role: isBridge ? "root" : "helper",
          ...(signal ?? abortSignal ? { abortSignal: (signal ?? abortSignal)! } : {}),
        });
        if (isBridge) {
          try {
            // MANDATORY, not an optional callback: the loopback guarantee is
            // only a guarantee if a bridge that binds the wrong interface
            // cannot start a session. `assertBridgeLoopbackOnly` waits for the
            // port to actually be listening first — probing before the bridge
            // binds would let every refused connection pass and then admit a
            // LAN listener that appeared a moment later.
            await assertBridgeLoopbackOnly({
              port: opts.bridgePort,
              ...(opts.bridgeReadinessTimeoutMs !== undefined
                ? { readinessTimeoutMs: opts.bridgeReadinessTimeoutMs }
                : {}),
            });
            if (opts.onBridgeStarted) {
              await opts.onBridgeStarted({
                pid: handle.pid,
                port: opts.bridgePort,
              });
            }
          } catch (error) {
            // Never leave the root running while reporting a failed spawn: the
            // caller has no handle to it, so nothing else would stop it.
            await opts.supervisor.stopSession(sessionId).catch(() => {});
            throw error;
          }
        }
        return handle;
      },

      // ── infra surface ─────────────────────────────────────────────────
      ports,
      getPortUrl: async ({ port, protocol }) => {
        if (!ports.includes(port)) {
          throw new Error(
            `port ${port} is not leased to this session; the local provider ` +
              `only resolves ports it opened`
          );
        }
        return localBridgeUrl({ port, ...(protocol ? { protocol } : {}) });
      },
      setPorts: async (next) => {
        ports.splice(0, ports.length, ...next);
      },
      // setNetworkPolicy is intentionally NOT implemented. A native provider
      // has no primitive that would enforce one, and the contract treats a
      // missing optional method as a no-op — so a misleading empty
      // implementation would be strictly worse than its absence.

      stop: async () => {
        const result = await opts.supervisor.stopSession(sessionId);
        if (!result.stopped) {
          throw new Error(
            `${result.escaped} supervised process tree(s) survived termination ` +
              `for session ${sessionId}; the session is NOT reported stopped`
          );
        }
      },
      destroy: async () => {
        const result = await opts.supervisor.stopSession(sessionId);
        if (!result.stopped) {
          throw new Error(
            `${result.escaped} supervised process tree(s) survived termination ` +
              `for session ${sessionId}`
          );
        }
        // `destroy` discards resumability, so the session's disposable state —
        // synthetic home, bridge state, caches — goes with it. `stop` keeps it,
        // because a stopped session can still be resumed.
        await removeSessionStateDir(opts.sessionStateDir);
      },

      restricted: () => session,
    };

    return session;
  };

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "mcpjam-local-supervised",
    bridgePorts: [opts.bridgePort],
    createSession: async (options) => {
      const sessionId = options?.sessionId ?? `local-${Date.now()}`;
      return buildSession(sessionId, options?.abortSignal);
    },
    // Resume reattaches to the SAME session state directory. Whether the
    // bridge process is still alive is the supervisor's registry to answer;
    // the adapter's own resume path reconnects to it when it is, and respawns
    // when it is not.
    resumeSession: async (options) =>
      buildSession(options.sessionId, options.abortSignal),
  };
}

/**
 * Remove a session's disposable state, re-checking containment first.
 *
 * Resolved on both sides before comparison: a prefix test on the raw string
 * would accept `<root>/../../etc`, and this ends in a recursive delete.
 */
async function removeSessionStateDir(dir: string): Promise<void> {
  const root = resolve(localHarnessStateRoot());
  const target = resolve(dir);
  if (target === root || !target.startsWith(root + sep)) {
    logger.warn("[local-harness] refusing to remove state outside the root", {
      dir,
    });
    return;
  }
  await rm(target, { recursive: true, force: true }).catch(() => {});
}

/** Session state directory for a local harness session. Always inside the
 *  owner-only local harness state root, so the janitor's containment check
 *  can never be tripped by a legitimate value. */
export function sessionStateDirFor(
  stateRoot: string,
  sessionId: string
): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error(
      `session id ${JSON.stringify(sessionId)} is not a single safe path segment`
    );
  }
  return join(stateRoot, "sessions", sessionId);
}
