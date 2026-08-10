/**
 * The E2B side of hosted plugin-stdio execution: put files in a box, run a
 * command, start the shim, and name the public port it listens on.
 *
 * This is the ONLY module in the plugin-runtime path that touches the vendor
 * SDK. `services/plugins/computer-stdio.ts` holds the policy (verify, place,
 * record, refuse) and consumes this through `PluginBoxConnector`, so the
 * pipeline's tests exercise the real policy against a stubbed vendor rather
 * than mocking the pipeline's own functions.
 *
 * The same rules the exec path follows apply here: `Sandbox.connect` attaches
 * to an ALREADY-awake box (the control plane owns provisioning, waking and
 * teardown) and nothing here ever stops or destroys one.
 */
import { CommandExitError, Sandbox } from "e2b";
import type {
  PluginBoxConnector,
  PluginBoxHandle,
} from "../../services/plugins/computer-stdio.js";

/**
 * E2B's per-command default is 60s; the shim is a long-lived server, and `0`
 * is the vendor's documented "no timeout". Without this the shim would be
 * killed a minute after it started, mid-session.
 */
const NO_COMMAND_TIMEOUT = 0;

/** Short: every command this module runs is a `test -f` or an `mkdir -p`. */
const PROBE_TIMEOUT_MS = 15_000;

/** The shim prints exactly one of these on stdout once it is listening. */
interface ShimReadyLine {
  event: "listening";
  host: string;
  port: number;
}

function parseReadyLine(line: string): ShimReadyLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { event?: unknown }).event !== "listening"
  ) {
    return null;
  }
  const port = (parsed as { port?: unknown }).port;
  const host = (parsed as { host?: unknown }).host;
  if (typeof port !== "number" || !Number.isInteger(port)) return null;
  return { event: "listening", host: typeof host === "string" ? host : "", port };
}

export const e2bPluginBoxConnector: PluginBoxConnector = async (box) => {
  const sandbox = await Sandbox.connect(box.sandboxId);

  const handle: PluginBoxHandle = {
    writeFiles: async (files) => {
      for (const file of files) {
        const slash = file.path.lastIndexOf("/");
        const dir = slash > 0 ? file.path.slice(0, slash) : "";
        if (dir) {
          // Idempotent + best-effort: a real problem surfaces as the write's
          // own error rather than as a confusing mkdir failure.
          try {
            await sandbox.files.makeDir(dir);
          } catch {}
        }
        // The vendor writer takes an ArrayBuffer, and a Uint8Array may be a
        // view into a larger one; copying out the exact window is what keeps a
        // subarray from writing its neighbours' bytes.
        const data = new ArrayBuffer(file.bytes.byteLength);
        new Uint8Array(data).set(file.bytes);
        await sandbox.files.write(file.path, data);
      }
    },

    run: async (command, options) => {
      try {
        const result = await sandbox.commands.run(command, {
          timeoutMs: options?.timeoutMs ?? PROBE_TIMEOUT_MS,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      } catch (error) {
        // A non-zero exit is how `test -f` answers "no"; it is data, not a
        // failure.
        if (error instanceof CommandExitError) {
          return {
            stdout: error.stdout,
            stderr: error.stderr,
            exitCode: error.exitCode ?? 1,
          };
        }
        throw error;
      }
    },

    startShim: async ({ scriptPath, env, readyTimeoutMs }) =>
      new Promise<{ port: number }>((resolve, reject) => {
        let settled = false;
        let carry = "";
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (outcome: { port: number } | Error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        };

        // Secrets travel in `envs`, never in the command line: argv is visible
        // to every process in the box (and to the vendor's command log), and
        // the token is the shim's whole access control.
        void sandbox.commands
          .run(`node ${JSON.stringify(scriptPath)}`, {
            background: true,
            envs: env,
            timeoutMs: NO_COMMAND_TIMEOUT,
            onStdout: (chunk: string) => {
              if (settled) return;
              carry += chunk;
              let index: number;
              while ((index = carry.indexOf("\n")) >= 0) {
                const line = carry.slice(0, index);
                carry = carry.slice(index + 1);
                const ready = parseReadyLine(line);
                if (ready) finish({ port: ready.port });
              }
            },
            // Deliberately not captured: the shim forwards the CHILD's stderr
            // here, which is plugin-authored output and may quote credentials.
            // Its startup failures are visible as an early exit below.
          })
          .then((command) => {
            // A shim that exits before it reports listening never bound: exit 2
            // is an invalid launch spec, exit 1 a port it could not take.
            void command
              .wait()
              .then(() =>
                finish(new Error("the plugin shim exited before listening"))
              )
              .catch((error) =>
                finish(
                  new Error(
                    `the plugin shim exited before listening (${
                      error instanceof CommandExitError
                        ? `code ${error.exitCode}`
                        : "unknown"
                    })`
                  )
                )
              );
          })
          .catch((error) =>
            finish(error instanceof Error ? error : new Error(String(error)))
          );

        timer = setTimeout(
          () =>
            finish(
              new Error(
                `the plugin shim did not report listening within ${readyTimeoutMs}ms`
              )
            ),
          readyTimeoutMs
        );
      }),

    publicOrigin: (port) => `https://${sandbox.getHost(port)}`,
  };

  return handle;
};
