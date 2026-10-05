/**
 * Docker-backed `HarnessV1SandboxProvider` — the hosted harness seam, run
 * against a local container instead of an E2B box. DEVELOPMENT AND CI ONLY:
 * `sandbox-provider-factory.ts` selects it for `HARNESS_SANDBOX_PROVIDER=docker`
 * and refuses that value in production.
 *
 * WHY IT EXISTS. The hosted stream mapping in `run-harness-turn.ts` — real
 * adapter, real bridge, real vendor CLI, real `fullStream` parts — had never
 * run in CI: the only box it could run on was an E2B sandbox, which needs a
 * vendor account and a model credential. This provider gives the SAME seam a
 * box that a GitHub runner can start, built from the same bake context as the
 * computer template (`docker/test-image.Dockerfile`), so the mapping can be
 * pinned by golden files (`docker/__tests__/hosted-harness-docker.e2e.test.ts`).
 *
 * SAME SEMANTICS AS THE E2B PROVIDER, deliberately, so what passes here means
 * something there:
 *   - it ATTACHES to a container somebody else started and never creates or
 *     removes one (`stop`/`destroy` are no-ops, like a control-plane-owned box);
 *   - commands run as the runtime user (`user`) through `bash -c`, rooted at
 *     the default working directory unless told otherwise;
 *   - a missing file reads as `null`, any other failure throws;
 *   - writes create their parent directories, as E2B's `files.write` does;
 *   - the session env bag is merged under each command's own env, and its
 *     delivery is stamped only once a command has actually received it;
 *   - the same pinned pnpm guard runs before the framework's bootstrap.
 *
 * What it does NOT model, and so what the Docker CI job does not cover: E2B's
 * egress transforms (the model-broker lease header, brokered secrets), its
 * network baseline, `Sandbox.connect` and the control plane's box lifecycle.
 * Those are mocked in the CI job and verified only by the staging release
 * check (`scripts/hosted-harness-release-check.mjs`).
 *
 * Contract → Docker mapping:
 *   file I/O        → `docker exec -i -u <user> <c> sh -c 'cat …'` (stdin/stdout)
 *   run / spawn     → `docker exec -u <user> -w <cwd> <c> bash -c <command>`
 *   kill            → the spawned command's process GROUP inside the container
 *                     (killing the `docker exec` client alone leaves it running)
 *   getPortEndpoint → loopback (`--network host`) or the container's bridge IP
 *
 * `docker cp` is deliberately NOT used for writes: it writes as the archive's
 * owner (root here), and a root-owned file in the user's home is one the
 * harness cannot rewrite on the next turn.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import { harnessPnpmGuardCommand } from "../harness-bake.js";

export interface DockerHarnessSandboxProviderOptions {
  /** Name or id of a RUNNING container to attach to. */
  containerId: string;
  /** Working dir inside the container. Defaults to the template home. */
  defaultWorkingDirectory?: string;
  /** User every command and file operation runs as. */
  user?: string;
  /** Port the in-container bridge binds to; surfaced via `session.ports`. */
  bridgePort?: number;
  /**
   * How this process reaches a container port.
   *  - `host-network`: the container runs with `--network host`, so its ports
   *    are this machine's loopback ports (the CI job's mode).
   *  - `container-ip`: the container's bridge-network IP from `docker inspect`
   *    (reachable from a Linux host; not from Docker Desktop's VM).
   */
  portAccess?: "host-network" | "container-ip";
  /** Per-command timeout for `run`. Matches the E2B provider's default. */
  commandTimeoutMs?: number;
  /** Session-wide env merged under each command's own env (see the E2B provider). */
  sessionEnv?: Record<string, string>;
  /** Fired once, when `sessionEnv` first reaches a command. */
  onSessionEnvUsed?: () => void;
  /** The docker CLI. */
  dockerBinary?: string;
  /** Injected in tests; `child_process.spawn` otherwise. */
  spawnProcess?: typeof nodeSpawn;
}

/** Exit code the read wrapper uses for "no such file", distinct from `cat`'s. */
const MISSING_FILE_EXIT = 44;
/** How long `kill` waits for a TERM'd process group before KILLing it. */
const KILL_GRACE_MS = 2_000;

type DockerResult = { exitCode: number; stdout: Buffer; stderr: Buffer };

export class DockerSandboxCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "DockerSandboxCommandError";
  }
}

export function createDockerHarnessSandboxProvider(
  opts: DockerHarnessSandboxProviderOptions,
): HarnessV1SandboxProvider {
  const docker = opts.dockerBinary ?? "docker";
  const spawnProcess = opts.spawnProcess ?? nodeSpawn;
  const user = opts.user ?? "user";
  const cwd = opts.defaultWorkingDirectory ?? "/home/user";
  const bridgePort = opts.bridgePort ?? 39271;
  const portAccess = opts.portAccess ?? "host-network";
  const commandTimeoutMs = opts.commandTimeoutMs ?? 10 * 60_000;
  const container = opts.containerId;
  const sessionEnv = opts.sessionEnv;
  let sessionEnvUsed = false;
  const markSessionEnvUsed = (): void => {
    if (!sessionEnv || sessionEnvUsed) return;
    sessionEnvUsed = true;
    try {
      opts.onSessionEnvUsed?.();
    } catch {
      // Best-effort by contract, as on the E2B provider.
    }
  };
  const mergeEnv = (
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    if (!sessionEnv) return env;
    return { ...sessionEnv, ...(env ?? {}) };
  };

  /**
   * `-e NAME` flags, with the VALUES in the docker client's own environment:
   * `docker exec -e NAME` copies the value from there, so a secret never sits
   * in an argv this machine's `ps` can read. `DOCKER_*` names would also steer
   * the client itself, so those few go inline instead.
   */
  const envArgs = (
    env: Record<string, string> | undefined,
  ): { args: string[]; clientEnv: NodeJS.ProcessEnv } => {
    const args: string[] = [];
    const clientEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of Object.entries(env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`invalid environment variable name: ${name}`);
      }
      if (name.startsWith("DOCKER_")) {
        args.push("-e", `${name}=${value}`);
      } else {
        args.push("-e", name);
        clientEnv[name] = value;
      }
    }
    return { args, clientEnv };
  };

  /** Run one `docker` invocation to completion. */
  const execDocker = (
    args: string[],
    options: {
      stdin?: Uint8Array;
      clientEnv?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<DockerResult> =>
    new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError(options.signal));
        return;
      }
      const child = spawnProcess(docker, args, {
        env: options.clientEnv ?? process.env,
        stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        child.kill("SIGKILL");
        finish(() => reject(abortError(options.signal!)));
      };
      const timer =
        options.timeoutMs !== undefined
          ? setTimeout(() => {
              child.kill("SIGKILL");
              finish(() =>
                reject(
                  new Error(
                    `docker ${args[0]} timed out after ${options.timeoutMs}ms`,
                  ),
                ),
              );
            }, options.timeoutMs)
          : undefined;
      timer?.unref?.();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) =>
        finish(() =>
          resolve({
            exitCode: code ?? 1,
            stdout: Buffer.concat(out),
            stderr: Buffer.concat(err),
          }),
        ),
      );
      if (options.stdin && child.stdin) {
        child.stdin.on("error", () => {
          // EPIPE when the command exits before reading everything; the exit
          // code is what reports the failure.
        });
        child.stdin.end(Buffer.from(options.stdin));
      }
    });

  /** `docker exec` as the runtime user, failing on a non-zero docker exit. */
  const execIn = async (
    script: string,
    scriptArgs: string[],
    options: { stdin?: Uint8Array; signal?: AbortSignal } = {},
  ): Promise<DockerResult> =>
    execDocker(
      [
        "exec",
        ...(options.stdin ? ["-i"] : []),
        "-u",
        user,
        container,
        "sh",
        "-c",
        script,
        "sh",
        ...scriptArgs,
      ],
      {
        ...(options.stdin ? { stdin: options.stdin } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: commandTimeoutMs,
      },
    );

  const readBytes = async (
    path: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null> => {
    const result = await execIn(
      `test -e "$1" || exit ${MISSING_FILE_EXIT}; exec cat -- "$1"`,
      [path],
      signal ? { signal } : {},
    );
    if (result.exitCode === MISSING_FILE_EXIT) return null;
    if (result.exitCode !== 0) {
      throw new DockerSandboxCommandError(
        `reading ${path} in container ${container} failed (exit ${result.exitCode}): ${result.stderr.toString("utf8").trim()}`,
        result.exitCode,
        result.stderr.toString("utf8"),
      );
    }
    return new Uint8Array(result.stdout);
  };

  const writeBytes = async (
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> => {
    const result = await execIn(
      'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
      [path],
      { stdin: bytes, ...(signal ? { signal } : {}) },
    );
    if (result.exitCode !== 0) {
      throw new DockerSandboxCommandError(
        `writing ${path} in container ${container} failed (exit ${result.exitCode}): ${result.stderr.toString("utf8").trim()}`,
        result.exitCode,
        result.stderr.toString("utf8"),
      );
    }
  };

  /** `docker exec` for a harness command: user, working dir, env, bash. */
  const commandArgs = (
    command: string[],
    workingDirectory: string | undefined,
    env: Record<string, string> | undefined,
  ) => {
    const { args, clientEnv } = envArgs(mergeEnv(env));
    return {
      args: [
        "exec",
        "-u",
        user,
        "-w",
        workingDirectory ?? cwd,
        ...args,
        container,
        ...command,
      ],
      clientEnv,
    };
  };

  /** Kill a spawned command's whole process group inside the container. */
  const killGroup = async (pidFile: string): Promise<void> => {
    const steps = Math.max(1, Math.round(KILL_GRACE_MS / 200));
    await execIn(
      [
        'p=$(cat "$1" 2>/dev/null) || exit 0',
        '[ -n "$p" ] || exit 0',
        'kill -TERM -- "-$p" 2>/dev/null || { rm -f "$1"; exit 0; }',
        `i=0; while [ $i -lt ${steps} ]; do kill -0 -- "-$p" 2>/dev/null || { rm -f "$1"; exit 0; }; sleep 0.2; i=$((i+1)); done`,
        'kill -KILL -- "-$p" 2>/dev/null',
        'rm -f "$1"',
      ].join("\n"),
      [pidFile],
    ).catch(() => {
      // The container may already be gone; there is nothing left to kill.
    });
  };

  const resolveHost = (() => {
    let cached: Promise<string> | undefined;
    return (): Promise<string> => {
      if (portAccess === "host-network") return Promise.resolve("127.0.0.1");
      cached ??= execDocker([
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
        container,
      ]).then((result) => {
        const ip = result.stdout
          .toString("utf8")
          .split(/\s+/)
          .find((value) => value.length > 0);
        if (result.exitCode !== 0 || !ip) {
          cached = undefined;
          throw new Error(
            `container ${container} has no bridge-network IP; start it with ` +
              "`--network host` and use portAccess `host-network`",
          );
        }
        return ip;
      });
      return cached;
    };
  })();

  const connectSession = async (
    signal?: AbortSignal,
  ): Promise<HarnessV1NetworkSandboxSession> => {
    const state = await execDocker(
      ["inspect", "-f", "{{.State.Running}}", container],
      signal ? { signal } : {},
    );
    if (
      state.exitCode !== 0 ||
      state.stdout.toString("utf8").trim() !== "true"
    ) {
      throw new Error(
        `docker container ${container} is not running; the Docker sandbox ` +
          "provider only attaches to a container someone else started",
      );
    }
    // The same pinned guard the E2B provider runs, for the same reason.
    const guard = await execDocker(
      [
        "exec",
        "-u",
        user,
        "-w",
        cwd,
        container,
        "bash",
        "-c",
        harnessPnpmGuardCommand(),
      ],
      { ...(signal ? { signal } : {}), timeoutMs: commandTimeoutMs },
    );
    if (guard.exitCode !== 0) {
      throw new Error(
        `pnpm is missing in container ${container} and installing it failed ` +
          `(exit ${guard.exitCode}): ${guard.stderr.toString("utf8").trim().slice(-500)}`,
      );
    }

    const ports: number[] = [bridgePort];
    let restrictedSession!: ReturnType<
      HarnessV1NetworkSandboxSession["restricted"]
    >;
    const endpoint = async (
      port: number,
      protocol?: "http" | "https" | "ws",
    ): Promise<string> =>
      `${protocol === "ws" ? "ws" : (protocol ?? "http")}://${await resolveHost()}:${port}`;

    const session: HarnessV1NetworkSandboxSession = {
      id: container,
      defaultWorkingDirectory: cwd,
      description:
        `Docker container ${container} (development/CI stand-in for an E2B ` +
        `computer). Working dir ${cwd}. Bridge port ${bridgePort}.`,

      // ── file I/O ──────────────────────────────────────────────────────
      readTextFile: async ({ path, abortSignal }) => {
        const bytes = await readBytes(path, abortSignal);
        return bytes === null ? null : Buffer.from(bytes).toString("utf8");
      },
      readBinaryFile: async ({ path, abortSignal }) =>
        readBytes(path, abortSignal),
      readFile: async ({ path, abortSignal }) => {
        const bytes = await readBytes(path, abortSignal);
        if (bytes === null) return null;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      },
      writeTextFile: async ({ path, content, abortSignal }) =>
        writeBytes(path, Buffer.from(content, "utf8"), abortSignal),
      writeBinaryFile: async ({ path, content, abortSignal }) =>
        writeBytes(path, content, abortSignal),
      writeFile: async ({ path, content, abortSignal }) => {
        const chunks: Uint8Array[] = [];
        const reader = content.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        await writeBytes(path, Buffer.concat(chunks), abortSignal);
      },

      // ── exec ──────────────────────────────────────────────────────────
      run: async ({ command, workingDirectory, env, abortSignal }) => {
        const { args, clientEnv } = commandArgs(
          ["bash", "-c", command],
          workingDirectory,
          env,
        );
        const result = await execDocker(args, {
          clientEnv,
          ...(abortSignal ? { signal: abortSignal } : {}),
          timeoutMs: commandTimeoutMs,
        });
        // The command was accepted and ran (whatever its exit), so the env
        // bag reached the container — the same rule as the E2B provider.
        markSessionEnvUsed();
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        };
      },

      spawn: async ({ command, workingDirectory, env, abortSignal }) => {
        // `setsid -w` puts the command in its own process group (and waits
        // for it, so the exit code is the command's); the group id is written
        // to a pid file so `kill` can take the WHOLE tree down inside the
        // container — killing the `docker exec` client does not.
        const pidFile = `/tmp/.mcpjam-docker-spawn-${randomUUID()}.pid`;
        const { args, clientEnv } = commandArgs(
          [
            "setsid",
            "-w",
            "sh",
            "-c",
            'echo "$$" > "$1"; exec bash -c "$2"',
            "sh",
            pidFile,
            command,
          ],
          workingDirectory,
          env,
        );
        const child: ChildProcess = spawnProcess(docker, args, {
          env: clientEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", () => resolve());
          child.once("error", reject);
        });
        markSessionEnvUsed();

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
        child.stdout?.on("data", (chunk: Buffer) => {
          if (!streamsClosed) outCtl.enqueue(new Uint8Array(chunk));
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (!streamsClosed) errCtl.enqueue(new Uint8Array(chunk));
        });
        const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
          child.once("close", (code, signal) =>
            resolve({ exitCode: code ?? (signal ? 137 : 1) }),
          );
        });
        void exitPromise.then(closeStreams);

        let killed: Promise<void> | undefined;
        const kill = (): Promise<void> => {
          killed ??= (async () => {
            try {
              await killGroup(pidFile);
            } finally {
              // Then the client, which exits on its own once the group is
              // gone; this only covers a wedged daemon connection.
              if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
              }
              closeStreams();
            }
          })();
          return killed;
        };
        abortSignal?.addEventListener("abort", () => void kill(), {
          once: true,
        });
        return {
          stdout,
          stderr,
          wait: async () => {
            try {
              return await exitPromise;
            } finally {
              closeStreams();
            }
          },
          kill,
        };
      },

      // ── infra surface ─────────────────────────────────────────────────
      ports,
      getPortEndpoint: async ({ port, protocol }) => ({
        url: await endpoint(port, protocol),
      }),
      getPortUrl: async ({ port, protocol }) => endpoint(port, protocol),
      setPorts: async (next) => {
        ports.splice(0, ports.length, ...next);
      },
      // Never tear down the container: like a control-plane-owned E2B box, it
      // belongs to whoever started it (the CI job, a developer). The harness
      // stops its own bridge through the spawn handle's `kill`.
      stop: async () => {},
      destroy: async () => {},
      restricted: () => restrictedSession,
    };
    restrictedSession = Object.freeze({
      description: session.description,
      readFile: session.readFile,
      readBinaryFile: session.readBinaryFile,
      readTextFile: session.readTextFile,
      writeFile: session.writeFile,
      writeBinaryFile: session.writeBinaryFile,
      writeTextFile: session.writeTextFile,
      spawn: session.spawn,
      run: session.run,
    });
    return session;
  };

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "mcpjam-docker",
    // Like the E2B provider: `identity`/`onFirstCreate` are for providers
    // that CREATE boxes; this one attaches, and the framework applies its own
    // idempotent bootstrap afterwards — which is the path the bake targets.
    createSession: (options) => connectSession(options?.abortSignal),
    resumeSession: (options) => connectSession(options?.abortSignal),
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
