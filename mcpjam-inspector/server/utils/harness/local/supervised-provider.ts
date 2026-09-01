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
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import { logger } from "../../logger.js";
import { localHarnessStateRoot } from "./grants.js";
import {
  assertBridgeLoopbackOnly,
  assertBridgePortUnclaimed,
  localBridgeUrl,
} from "./bridge-endpoint.js";
import { confinePath } from "./confine.js";
import {
  classifyBootstrapPath,
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
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const abortError = (): Error =>
    abortSignal?.reason instanceof Error
      ? abortSignal.reason
      : new Error("aborted");

  // Set up ONCE, outside the loop — a listener per iteration would leak on a
  // long stream. Checking the flag before each read is not enough on its own:
  // the stream here comes from the adapter, and one that never enqueues and
  // never closes leaves `reader.read()` pending forever, with the `writeFile`
  // waiting on the bytes pending behind it, after the session was aborted.
  let removeAbortListener = (): void => {};
  let abortRace: Promise<never> | null = null;
  if (abortSignal !== undefined) {
    abortRace = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(abortError());
      abortSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        abortSignal.removeEventListener("abort", onAbort);
    });
    // The race attaches a handler each iteration, but nothing listens once the
    // loop ends; without this a later abort is an unhandled rejection.
    abortRace.catch(() => {});
  }

  try {
    for (;;) {
      if (abortSignal?.aborted) throw abortError();
      const pending = reader.read();
      // Same reason: when the race abandons this read, releasing the lock
      // errors it, and nobody would be listening.
      pending.catch(() => {});
      const { done, value } =
        abortRace === null
          ? await pending
          : await Promise.race([pending, abortRace]);
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch (error) {
    // Let the source go rather than leaving it pumping into a reader nothing
    // will read again. Not awaited: a source whose `cancel` hangs would just
    // reintroduce the hang this is here to remove.
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    removeAbortListener();
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
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  return new TextDecoder().decode(await collectStreamBytes(stream));
}

export function createSupervisedLocalHarnessProvider(
  opts: SupervisedLocalHarnessProviderOptions,
): HarnessV1SandboxProvider {
  const syntheticHome = join(opts.sessionStateDir, "home");
  // The writable half of the adapter's bootstrap directory. The framework
  // writes a `.bootstrap-<identity>.ok` marker there to skip re-bootstrapping;
  // ours lives in disposable session state instead of the user's checkout, so
  // a local session leaves no adapter scaffolding behind.
  const bootstrapOverlay = join(opts.sessionStateDir, "bootstrap");

  const buildSession = async (
    sessionId: string,
    abortSignal?: AbortSignal,
  ): Promise<HarnessV1NetworkSandboxSession> => {
    // Session state first: the synthetic home must exist before a vendor CLI's
    // first write, and it must be owner-only from the moment it exists rather
    // than tightened afterwards.
    for (const dir of syntheticHomeDirectories(syntheticHome)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await mkdir(bootstrapOverlay, { recursive: true, mode: 0o700 });

    // The two roots the Inspector file API will touch, and nothing else.
    //
    // Both are CANONICAL: `confinePath` compares an already-resolved candidate
    // against these, so a root that still contains a symlink (a symlinked
    // $HOME, or macOS's /var -> /private/var) would never match its own
    // canonical children and would refuse every path under it. The workspace
    // is realpath'd when its grant is issued; the state directory is resolved
    // here, after the directories above exist.
    const roots = [await realpath(opts.sessionStateDir), opts.workspacePath];
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
      // Resolved exactly as the framework resolves it — against the session's
      // default working directory — so the translator matches the string the
      // adapters will actually emit.
      adapterBootstrapDir: posix.resolve(
        opts.workspacePath,
        opts.manifest.adapterBootstrapDir,
      ),
      managedBundleRoot: opts.runtime.rootPath,
      adapterBootstrapFiles: opts.manifest.adapterBootstrapFiles,
      bootstrapOverlayDir: bootstrapOverlay,
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

    /**
     * Where a read should actually come from.
     *
     * The adapter's bootstrap files live in the verified managed bundle, not in
     * the workspace, so a read of one has to follow the same remap the command
     * translator applies — otherwise the framework's own `readTextFile` of its
     * marker, and any read-back of a recipe file, would miss.
     */
    const resolveForRead = async (path: string): Promise<string> => {
      const target = classifyBootstrapPath(path, translationContext);
      // The bundle is digest-verified and read-only to the session, and its
      // path came from the translator's own containment check — `confine`
      // would reject it, since the bundle is not one of the session's writable
      // roots. The overlay IS under a session root, so it goes through the
      // same symlink-aware check everything else does: a symlink planted at
      // the marker's name would otherwise redirect a read out of session state.
      if (target.kind === "bundle-asset") return target.bundlePath;
      if (target.kind === "session-overlay") return confine(target.overlayPath);
      return confine(path);
    };

    /**
     * Where a write should actually go, or `null` when the verified bundle
     * already satisfies it.
     *
     * A declared bootstrap asset is never written: the bundle holds the copy
     * that will actually run. It is COMPARED instead, and a difference fails
     * the session closed — the adapter is telling us its recipe no longer
     * matches the bundle the manifest pins, which is a manifest review, not
     * something to paper over by writing a file nothing will read.
     */
    const resolveForWrite = async (
      path: string,
      bytes: Uint8Array,
    ): Promise<string | null> => {
      const target = classifyBootstrapPath(path, translationContext);
      if (target.kind === "session-overlay") {
        return confine(target.overlayPath);
      }
      if (target.kind === "workspace") return confine(path);

      let existing: Buffer;
      try {
        existing = await readFile(target.bundlePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new Error(
          `the managed ${opts.harnessId} bundle does not contain ` +
            `${target.relativePath}, which the pinned adapter's bootstrap ` +
            `recipe writes. The bundle and the pinned adapter disagree; ` +
            `refusing rather than installing it into the workspace.`,
        );
      }
      if (!existing.equals(Buffer.from(bytes))) {
        throw new Error(
          `the pinned adapter's ${target.relativePath} differs from the copy ` +
            `in the verified managed bundle. Local sessions run the bundle's ` +
            `copy, so this session would not be running what the adapter ` +
            `bootstrapped; refusing until the bundle is rebuilt for this ` +
            `adapter version.`,
        );
      }
      logger.debug("[local-harness] bootstrap file satisfied by bundle", {
        file: target.relativePath,
      });
      return null;
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

    const assertPortLeased = (port: number): void => {
      if (!ports.includes(port)) {
        throw new Error(
          `port ${port} is not leased to this session; the local provider ` +
            `only resolves ports it opened`,
        );
      }
    };

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
            `a runtime identity, so a changed runtime needs fresh consent.`,
        );
      }
    };

    /** Session environment plus the adapter's allowlisted per-call additions. */
    const envFor = (
      supplied: Readonly<Record<string, string>> | undefined,
    ): Record<string, string> => ({
      ...env,
      ...filterBridgeSuppliedEnv(supplied),
    });

    const runTranslated = async (
      translated: TranslatedCommand,
      abort?: AbortSignal,
      suppliedEnv?: Readonly<Record<string, string>>,
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
      readTextFile: async ({
        path,
        abortSignal: _s,
        encoding,
        startLine,
        endLine,
      }) => {
        const canonical = await resolveForRead(path);
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
        const to =
          endLine === undefined
            ? lines.length
            : Math.min(endLine, lines.length);
        return lines.slice(from, to).join("\n");
      },
      readBinaryFile: async ({ path }) => {
        const canonical = await resolveForRead(path);
        try {
          return new Uint8Array(await readFile(canonical));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      readFile: async ({ path }) => {
        const canonical = await resolveForRead(path);
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
        const charset = (encoding as BufferEncoding | undefined) ?? "utf8";
        const canonical = await resolveForWrite(
          path,
          Buffer.from(content, charset),
        );
        if (canonical === null) return;
        await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
        await writeFile(canonical, content, {
          encoding: charset,
          mode: 0o600,
        });
      },
      writeBinaryFile: async ({ path, content }) => {
        const canonical = await resolveForWrite(path, content);
        if (canonical === null) return;
        await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
        await writeFile(canonical, content, { mode: 0o600 });
      },
      writeFile: async ({ path, content, abortSignal: signal }) => {
        // Bytes, not text: this is the contract's binary write primitive.
        const bytes = await collectStreamBytes(content, signal ?? abortSignal);
        const canonical = await resolveForWrite(path, bytes);
        if (canonical === null) return;
        await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
        await writeFile(canonical, bytes, { mode: 0o600 });
      },

      // ── exec ──────────────────────────────────────────────────────────
      run: async ({
        command,
        workingDirectory,
        abortSignal: signal,
        env: suppliedEnv,
      }) => {
        const translated = await translateAdapterCommand(
          { command, workingDirectory, env: suppliedEnv },
          translationContext,
        );
        return runTranslated(translated, signal ?? abortSignal, suppliedEnv);
      },

      spawn: async ({
        command,
        workingDirectory,
        abortSignal: signal,
        env: suppliedEnv,
      }) => {
        const translated = await translateAdapterCommand(
          { command, workingDirectory, env: suppliedEnv },
          translationContext,
        );
        if (translated.kind !== "exec") {
          // The adapters only ever `spawn` the bridge, but the contract allows
          // any command here; a non-exec translation is satisfied immediately
          // rather than being quietly upgraded into a process.
          const result = await runTranslated(
            translated,
            signal ?? abortSignal,
            suppliedEnv,
          );
          return completedProcess(result.stdout, result.exitCode);
        }
        const isBridge = !bridgeClaimed;
        if (isBridge) bridgeClaimed = true;
        // Released on ANY failure below. Leaving the claim set after a failed
        // first spawn would make a same-session retry a "helper" — and helpers
        // skip the mandatory exposure probe, which is exactly how a LAN-bound
        // bridge would get admitted unchecked.
        const releaseBridgeClaim = () => {
          if (isBridge) bridgeClaimed = false;
        };
        let handle: Awaited<ReturnType<typeof opts.supervisor.spawnSupervised>>;
        try {
          await assertRuntimeUnchanged();
          // Before the bridge exists, not after: once it is running, an
          // accepted connection on the leased port is indistinguishable from
          // "our bridge came up" and "our bridge failed to bind and something
          // else answered".
          if (isBridge) {
            await assertBridgePortUnclaimed({ port: opts.bridgePort });
          }
          handle = await opts.supervisor.spawnSupervised({
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
            ...((signal ?? abortSignal)
              ? { abortSignal: (signal ?? abortSignal)! }
              : {}),
          });
        } catch (error) {
          releaseBridgeClaim();
          throw error;
        }
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
              // Ties the listener to the process we started: a port answering
              // after our bridge died is somebody else's.
              isBridgeAlive: async () =>
                opts.supervisor.liveProcessCount(sessionId) > 0,
            });
            if (opts.onBridgeStarted) {
              await opts.onBridgeStarted({
                pid: handle.pid,
                port: opts.bridgePort,
              });
            }
          } catch (error) {
            // Never leave the root running while reporting a failed spawn: the
            // caller has no handle to it, so nothing else would stop it. And
            // release the claim, so a retry is checked as a bridge again.
            releaseBridgeClaim();
            await opts.supervisor.stopSession(sessionId).catch(() => {});
            throw error;
          }
        }
        return handle;
      },

      // ── infra surface ─────────────────────────────────────────────────
      ports,
      // Both resolvers answer from the same loopback authority. The stable
      // contract made `getPortEndpoint` the required one and left `getPortUrl`
      // in place as deprecated; a local provider must never let either return
      // an address reachable from off-box.
      getPortEndpoint: async ({ port, protocol }) => {
        assertPortLeased(port);
        return {
          url: localBridgeUrl({ port, ...(protocol ? { protocol } : {}) }),
        };
      },
      getPortUrl: async ({ port, protocol }) => {
        assertPortLeased(port);
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
              `for session ${sessionId}; the session is NOT reported stopped`,
          );
        }
      },
      destroy: async () => {
        const result = await opts.supervisor.stopSession(sessionId);
        if (!result.stopped) {
          throw new Error(
            `${result.escaped} supervised process tree(s) survived termination ` +
              `for session ${sessionId}`,
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
    // `bridgePorts` is gone from the stable contract: port discovery is the
    // adapter's job now, reading `session.ports` and resolving through
    // `getPortEndpoint`.
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
  // Deliberately NOT swallowed: `destroy` promises the session's disposable
  // state is gone, and a caller that is told it succeeded will not retry.
  await rm(target, { recursive: true, force: true });
}

/** Session state directory for a local harness session. Always inside the
 *  owner-only local harness state root, so the janitor's containment check
 *  can never be tripped by a legitimate value. */
export function sessionStateDirFor(
  stateRoot: string,
  sessionId: string,
): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error(
      `session id ${JSON.stringify(
        sessionId,
      )} is not a single safe path segment`,
    );
  }
  return join(stateRoot, "sessions", sessionId);
}
