// Decompose session-start cost: full-tree digest vs bare bridge spawn-to-listen.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { computeTreeDigest } from "../runtime-identity.js";

const ROOT = process.env.CONFORMANCE_ROOT!;
const B = join(ROOT, "runtime", "claude-code");
/** A bridge that has not listened by now is not slow, it is broken. */
const LISTEN_TIMEOUT_MS = 60_000;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

/**
 * Wait for the port to accept, bounded, and give up if the child dies first.
 *
 * Both halves matter. Without the deadline a launcher that fails to bind
 * leaves this polling forever and the CI job dies on its own timeout with
 * nothing said about why. Without the exit signal it polls for the full
 * minute after the child has already exited — the answer is available
 * immediately and the script sat on it.
 */
function waitListen(
  port: number,
  child: { exitCode: number | null; once: Function },
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const t0 = performance.now();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.once("exit", (code: number | null) =>
      finish(() =>
        reject(new Error(`the bridge exited (${code}) before it listened`)),
      ),
    );
    const tick = () => {
      if (settled) return;
      if (performance.now() - t0 > LISTEN_TIMEOUT_MS) {
        finish(() =>
          reject(
            new Error(
              `port ${port} never listened within ${LISTEN_TIMEOUT_MS}ms`,
            ),
          ),
        );
        return;
      }
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        finish(() => resolve(Math.round(performance.now() - t0)));
      });
      sock.once("error", () => {
        sock.destroy();
        setTimeout(tick, 5);
      });
    };
    tick();
  });
}

for (let i = 0; i < 3; i++) {
  const t = performance.now();
  await computeTreeDigest(B);
  console.log(`digest #${i + 1}: ${Math.round(performance.now() - t)}ms`);
}

for (let i = 0; i < 3; i++) {
  const port = await freePort();
  const dir = join(ROOT, "timing", `s${i}`);
  await mkdir(join(dir, "bridge"), { recursive: true });
  const t = performance.now();
  const child = spawn(
    join(B, "bin", "node"),
    [
      join(B, "launcher.mjs"),
      "--workdir",
      dir,
      "--bridge-state-dir",
      join(dir, "bridge"),
    ],
    {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        BRIDGE_CHANNEL_TOKEN: "t",
        BRIDGE_WS_PORT: String(port),
      },
      // stderr INHERITED, not discarded: when a launcher fails to bind, its
      // stderr is the only thing that says why, and this script used to throw
      // it away and then wait forever.
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    },
  );
  // `finally`, because the child is detached: an abort anywhere in the body
  // would otherwise leave a bridge process group running for the rest of the
  // job, and the workflow's final "no supervised process survived" step would
  // fail pointing at this script.
  try {
    const ms = await waitListen(port, child);
    console.log(
      `bridge spawn->listen #${i + 1}: ${ms}ms (total ${Math.round(performance.now() - t)}ms)`,
    );
  } finally {
    // ESRCH when the group is already gone, which is not an error here and
    // used to abort the remaining iterations.
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
