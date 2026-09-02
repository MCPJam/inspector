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
 *   getPortEndpoint / getPortUrl ({ port }) → sandbox.getHost(port)   ← bridge
 *   id / defaultWorkingDirectory / ports    → native E2B
 *   stop / destroy                          → no-op (control plane owns teardown)
 */
import { Sandbox, FileNotFoundError, CommandExitError } from "e2b";
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import { confineToHome } from "../computers/path-confine.js";
import { logger } from "../logger.js";

export interface E2BHarnessSandboxProviderOptions {
  /**
   * Fired the first time `sessionEnv` is actually merged into a command's
   * environment — i.e. when the box really receives the values, not when the
   * provider is constructed holding them.
   *
   * The distinction is what `lastDeliveredAt` is read for. Constructing this
   * provider only puts the values in a local object; harness setup can still
   * throw before any command runs (the model broker install is the usual one),
   * and stamping there would mark an unused credential active for whoever is
   * deciding whether it is safe to delete.
   *
   * Called at most once per provider, and never when there is no session env.
   */
  onSessionEnvUsed?: () => void;
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
  /**
   * SESSION-WIDE environment merged into every `run` and `spawn`.
   *
   * This is how a MATERIALIZED project secret reaches a CLI in the box: the
   * agent runs `stripe customers list`, and `STRIPE_API_KEY` has to be in that
   * process's environment. Per-command `env` already existed, but the harness
   * composes its own commands — nothing upstream of a `run` call knows to add a
   * credential to it — so the bag has to live with the session.
   *
   * A CALLER-SUPPLIED `env` WINS on collision. The session bag is ambient
   * configuration; a per-command value is a deliberate override at the call
   * site, and ambient config silently beating an explicit argument is the
   * surprise nobody debugs successfully.
   *
   * Secrets travel in `envs`, never in the command line — the rule
   * `plugin-box.ts` already states, for the same reason: argv is visible to
   * every process in the box through `/proc` and lands in shell history.
   */
  sessionEnv?: Record<string, string>;
}

const enc = new TextEncoder();

/**
 * Path confinement for the harness file writers — keeps every `write*` under the
 * box home (`/home/user`), the same hygiene the `/computers/upload` route
 * applies. Shipped LOG-ONLY by default: the Claude Code adapter writes its
 * workdir, `.claude/skills`, and `.mcp.json` (all under `/home/user`), but this
 * layer had zero confinement before, so a hard reject could break a turn on a
 * legitimate write we haven't accounted for. Set
 * `HARNESS_WRITE_CONFINE_ENFORCE=true` to reject once real traffic confirms no
 * legitimate escapes. Like the upload route this is hygiene, not the trust
 * boundary — the harness runs arbitrary code in the box by design.
 */
function enforceHarnessWritePath(path: string): void {
  if (confineToHome(path) !== null) return;
  const enforce = process.env.HARNESS_WRITE_CONFINE_ENFORCE === "true";
  logger.warn("[e2b-sandbox-provider] write path escapes /home/user", {
    path,
    enforce,
  });
  if (enforce) {
    throw new Error(`refusing to write outside /home/user: ${path}`);
  }
}

/**
 * Pass a caller's `abortSignal` down to E2B, omitting the key when there is
 * none.
 *
 * Worth being precise about what this buys, because the sandbox contract
 * promises more than the vendor delivers: E2B's `signal` cancels the in-flight
 * REQUEST, so an aborted call rejects promptly instead of waiting out
 * `commandTimeoutMs` — which for the harness bootstrap is ten minutes of a dead
 * turn holding a box. It does not guarantee the process inside the box dies.
 * That is the difference between a turn that ends when the user cancels it and
 * one that appears to hang, so it is the part worth having; a box-side kill
 * would need spawn/kill plumbing on every exec path and buys nothing while the
 * box itself is short-lived or about to be reclaimed.
 */
function signalOpt(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

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
  stream: ReadableStream<Uint8Array>
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
  opts: E2BHarnessSandboxProviderOptions
): HarnessV1SandboxProvider {
  const bridgePort = opts.bridgePort ?? 39271;
  const cwd = opts.defaultWorkingDirectory ?? "/home/user";
  // E2B foreground `commands.run` defaults to a ~60s command timeout, separate
  // from the sandbox's own lifetime — too short for the harness bootstrap
  // (`pnpm install`). Background `spawn` is not subject to this cap.
  const commandTimeoutMs = opts.commandTimeoutMs ?? 10 * 60_000;
  // Frozen at provider construction. The session's env is fixed for its
  // lifetime by design: a harness session that changed its environment
  // mid-flight would hand different commands different credentials, and the
  // runtime fingerprint exists precisely so a change forks a NEW session
  // instead.
  const sessionEnv = opts.sessionEnv;
  // Latched: several commands in one session must not stamp several times, and
  // the question the stamp answers ("did anything receive this?") is answered
  // by the first one.
  let sessionEnvUsed = false;
  const markSessionEnvUsed = (): void => {
    if (!sessionEnv || sessionEnvUsed) return;
    sessionEnvUsed = true;
    // Best-effort by contract: failing to RECORD a delivery must never fail
    // the delivery itself, and this sits directly in the command path.
    try {
      opts.onSessionEnvUsed?.();
    } catch {
      // ignore
    }
  };
  const mergeEnv = (
    env: Record<string, string> | undefined
  ): Record<string, string> | undefined => {
    if (!sessionEnv) return env;
    return { ...sessionEnv, ...(env ?? {}) };
  };

  // Connect to the host's persistent computer and build a session bound to it.
  // Shared by createSession (fresh) and resumeSession (reattach): for our E2B
  // provider both are the same operation — reconnect to the SAME long-lived box.
  // On resume the Claude Code adapter rehydrates its thread from the workdir
  // (which persists on the box) using the `resumeFrom` state; our provider just
  // has to supply the sandbox connection.
  const connectSession = async (
    connectSignal?: AbortSignal
  ): Promise<HarnessV1NetworkSandboxSession> => {
    // Reuse the host's existing computer. It must already be awake — the
    // caller wakes it via the control plane (`ensureComputerReady`) before
    // resolving the sandboxId. We never create or kill a box here.
    const sandbox = await Sandbox.connect(opts.sandboxId, {
      apiKey: opts.apiKey,
      timeoutMs: opts.connectTimeoutMs,
      ...(connectSignal ? { signal: connectSignal } : {}),
    });

    // Mutated in place by setPorts so `session.ports` (same ref) stays live.
    const ports: number[] = [bridgePort];

    // The harness bootstrap shells `pnpm install` BEFORE any session hook runs.
    // pnpm is baked into the computer template (mcpjam-backend
    // templates/computer/e2b.Dockerfile); this idempotent guard covers boxes
    // provisioned before that template rebuild lands, and no-ops once pnpm is
    // present. We do not own the box, so a failure here propagates (the control
    // plane still owns teardown).
    //
    // Where it runs matters: on the harness path this is reached during PREWARM,
    // while the box still has ordinary egress. Reached after a lease has locked
    // the box down, the `npm install` fallback cannot see the registry and
    // spends a minute of retries before failing — which is why the failure is
    // spelled out below rather than surfacing as E2B's bare "exit status 1".
    try {
      await sandbox.commands.run("command -v pnpm || npm install -g pnpm", {
        timeoutMs: commandTimeoutMs,
        ...(connectSignal ? { signal: connectSignal } : {}),
      });
    } catch (err) {
      if (err instanceof CommandExitError) {
        const output = (err.stderr || err.stdout || "").trim();
        throw new Error(
          `pnpm is missing on sandbox ${opts.sandboxId} and installing it failed ` +
            `(exit ${err.exitCode}). If the box's egress is already locked to the ` +
            `model proxy, the package registry is unreachable by design — the ` +
            `harness runtime must be installed before that lock. Output: ` +
            (output ? output.slice(-500) : "(none)"),
          { cause: err }
        );
      }
      throw err;
    }

    const session: HarnessV1NetworkSandboxSession = {
      id: sandbox.sandboxId,
      defaultWorkingDirectory: cwd,
      description:
        `E2B sandbox ${sandbox.sandboxId} (host computer). Working dir ${cwd}. ` +
        `Bridge port ${bridgePort} reachable at ${sandbox.getHost(
          bridgePort
        )}.`,

      // ── file I/O ──────────────────────────────────────────────────────
      readTextFile: async ({ path, abortSignal }) => {
        try {
          return await sandbox.files.read(path, signalOpt(abortSignal));
        } catch (err) {
          return nullIfMissing(err); // null only for a genuinely missing file
        }
      },
      readBinaryFile: async ({ path, abortSignal }) => {
        try {
          return await sandbox.files.read(path, {
            format: "bytes",
            ...signalOpt(abortSignal),
          });
        } catch (err) {
          return nullIfMissing(err);
        }
      },
      readFile: async ({ path, abortSignal }) => {
        try {
          const bytes = await sandbox.files.read(path, {
            format: "bytes",
            ...signalOpt(abortSignal),
          });
          return bytesToStream(bytes);
        } catch (err) {
          return nullIfMissing(err);
        }
      },
      writeTextFile: async ({ path, content, abortSignal }) => {
        enforceHarnessWritePath(path);
        await sandbox.files.write(
          [{ path, data: content }],
          signalOpt(abortSignal)
        );
      },
      writeBinaryFile: async ({ path, content, abortSignal }) => {
        enforceHarnessWritePath(path);
        await sandbox.files.write(
          [{ path, data: u8ToArrayBuffer(content) }],
          signalOpt(abortSignal)
        );
      },
      writeFile: async ({ path, content, abortSignal }) => {
        enforceHarnessWritePath(path);
        const bytes = await streamToBytes(content);
        await sandbox.files.write(
          [{ path, data: u8ToArrayBuffer(bytes) }],
          signalOpt(abortSignal)
        );
      },

      // ── exec ──────────────────────────────────────────────────────────
      run: async ({ command, workingDirectory, env, abortSignal }) => {
        try {
          const res = await sandbox.commands.run(command, {
            cwd: workingDirectory ?? cwd,
            envs: mergeEnv(env),
            timeoutMs: commandTimeoutMs,
            ...signalOpt(abortSignal),
          });
          // E2B accepted and completed the command, so the session env was
          // actually handed to the box. A transport rejection before
          // acceptance must not mark delivery.
          markSessionEnvUsed();
          return {
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
          };
        } catch (err) {
          // E2B throws on non-zero exit; the contract wants the result
          // (exitCode + streams) surfaced, not a rejection.
          if (err instanceof CommandExitError) {
            // A CommandExitError means the command was accepted and ran.
            markSessionEnvUsed();
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
      spawn: async ({ command, workingDirectory, env, abortSignal }) => {
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
          envs: mergeEnv(env),
          ...signalOpt(abortSignal),
          // Guard against enqueue-after-close once the process ends/is killed.
          onStdout: (d: string) => {
            if (!streamsClosed) outCtl.enqueue(enc.encode(d));
          },
          onStderr: (d: string) => {
            if (!streamsClosed) errCtl.enqueue(enc.encode(d));
          },
        });
        // A background handle is returned only after E2B accepted the process.
        markSessionEnvUsed();
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
      // The claude-code adapter leases its bridge port from `ports` and calls
      // this to open its WebSocket. E2B's `getHost` URL is directly reachable,
      // so no scoped headers are needed on the endpoint. IMPORTANT for the
      // broker model: this URL is the in-sandbox bridge, NOT a model endpoint —
      // model traffic leaves the box through the E2B egress transform that
      // injects the broker lease outside the VM (see harness-model-broker.ts).
      getPortEndpoint: async ({ port, protocol }) => {
        const host = sandbox.getHost(port);
        const scheme = protocol === "ws" ? "wss" : protocol ?? "https";
        return { url: `${scheme}://${host}` };
      },
      // Deprecated in the stable contract but still required; same resolution.
      getPortUrl: async ({ port, protocol }) => {
        const host = sandbox.getHost(port);
        const scheme = protocol === "ws" ? "wss" : protocol ?? "https";
        return `${scheme}://${host}`;
      },
      // Never tear down a shared host computer: the control plane owns its
      // lifecycle (provision / wake / hibernate / delete). Ending a harness
      // session leaves the box running. The harness cleans up its own bridge
      // process via the spawn handle's kill(), not via the sandbox.
      stop: async () => {
        /* no-op — control-plane-owned box */
      },
      // `destroy` is now REQUIRED by the stable contract ("stop, then delete
      // the backing resource; implementations with no cleanup beyond stopping
      // may delegate to stop()"). The framework calls it when a harness session
      // is destroyed and it considers the sandbox harness-owned — but this box
      // is NOT harness-owned: it is the host's parked computer, kept alive for
      // resume between turns. So destroy, like stop, must leave it running.
      destroy: async () => {
        /* no-op — control-plane-owned box; parked between turns for resume */
      },
      setPorts: async (next) => {
        // Mutate in place so `session.ports` (same reference) reflects it.
        ports.splice(0, ports.length, ...next);
      },
      // setNetworkPolicy omitted — E2B sets egress at create time; the
      // optional-call contract treats a missing impl as a no-op.
      //
      // `setRequestTransformations` / `addRequestTransformations` are omitted
      // DELIBERATELY, and the cost of the omission is one console warning per
      // Cursor turn: "The sandbox implementation does not support configuring
      // request transformations, so credential brokering does not work.
      // Falling back to less secure credential forwarding."
      // (`@ai-sdk/harness`'s `warnCredentialBrokeringUnavailable`.) Three
      // independent reasons, any one of which would be enough:
      //
      //  1. IT WOULD PUT THE REAL KEY IN THIS PROCESS. The framework hook is
      //     called with the credential in `transform.headers` — its model is
      //     "the HOST holds the key, the box gets a placeholder". MCPJam's
      //     brokered project secrets are strictly stronger: the plaintext stays
      //     behind KMS in the backend and is composed into the box's egress
      //     policy there, so it never reaches the inspector at all. Wiring the
      //     hook would be a regression dressed as a hardening.
      //
      //  2. E2B CANNOT EXPRESS THE MATCH. `HarnessV1RequestTransformation`
      //     matches on host + path + method + header VALUE; E2B's network API
      //     (`SandboxNetworkConfig.rules`) is keyed by DOMAIN alone and injects
      //     unconditionally. Implementing the hook would mean silently widening
      //     "this one exchange request carrying this exact placeholder" into
      //     "every request to this host", which is not the rule the adapter
      //     asked for.
      //
      //  3. THE WRITE IS REPLACE, AND WE DO NOT OWN THE BASELINE.
      //     `PUT /sandboxes/{id}/network` replaces the whole rule set, and the
      //     box's policy is composed by the CONTROL PLANE from its egress
      //     baseline, its brokered project secrets, and (mid-turn) the model
      //     lease header — see `composeBoxPolicy` and the
      //     `hasActiveBrokerLease` precondition in mcpjam-backend. A write from
      //     here holding only the adapter's rule would strip all of that
      //     IRREVERSIBLY: the lease value exists only inside the transform and
      //     cannot be read back, so the in-flight run would 401 for the rest of
      //     its life. An ADDITIVE implementation is what the contract asks for
      //     and is not something this side can build without a backend endpoint
      //     that merges into the composed policy.
      //
      // The brokered credential path (`external-account-credentials.ts`) gets
      // the same outcome the hook was for — real key outside the VM, placeholder
      // inside — through the control plane instead.

      restricted: () => session, // same resource, narrower static type
    };

    return session;
  };

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "mcpjam-e2b",
    // The canary-era provider-level `bridgePorts` pool is gone from the stable
    // contract: adapters now lease the bridge port from the SESSION's `ports`
    // array (claude-code's resolveBridgePort reads ports[0]) and resolve it
    // via `getPortEndpoint`. Our sessions already expose `[bridgePort]`.

    // `identity` and `onFirstCreate` are deliberately unused: they exist for
    // providers that CREATE and snapshot boxes, and this one only ever attaches
    // to a box the control plane already owns. The framework applies its own
    // idempotent bootstrap after attaching, which is the path that matters here.
    // `abortSignal` IS honored, so a cancelled turn stops waiting on the box
    // instead of holding it until the command timeout.
    createSession: (options) => connectSession(options?.abortSignal),

    // Reattach for multi-turn continuity. The harness only invokes this when a
    // turn passes `resumeFrom`; presence of this method is the capability the
    // agent checks (`_acquireSandbox` throws HarnessCapabilityUnsupportedError
    // otherwise). We ignore the harness `sessionId` — the box is the project's
    // single computer resolved per-turn via the control plane — and reconnect;
    // the Claude Code adapter restores the thread from the workdir.
    resumeSession: (options) => connectSession(options?.abortSignal),
  };
}
