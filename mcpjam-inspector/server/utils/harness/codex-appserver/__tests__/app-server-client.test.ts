/**
 * Teardown of the `codex app-server` child, against a REAL process.
 *
 * The client tracks two different things that look like one: whether the CLIENT
 * is usable, and whether the PROCESS is gone. Conflating them is not a tidiness
 * problem — `ensureRuntime` tears a runtime down in order to build the next one,
 * so a `kill()` that returns early leaves two Codex processes sharing a
 * CODEX_HOME and racing for the relay port, and the second one's turns fail in
 * ways that point nowhere near here.
 *
 * A real child on purpose: signal delivery, reaping, and EPIPE on a closed pipe
 * are exactly the behaviours a mock would define away.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  spawnAppServerClient,
  type AppServerClient,
} from "../bridge/app-server-client.js";

/*
 * Every client this file spawns, reaped after the case that made it.
 *
 * Not decoration: two of these children are deliberately hard to kill (one
 * ignores SIGTERM, one runs `setInterval` forever), so a failed assertion
 * before the case's own `kill()` would leak exactly the process this file
 * exists to prove gets cleaned up. `kill()` is idempotent once the child is
 * gone, so reaping a client a passing case already killed costs nothing.
 */
const spawned: AppServerClient[] = [];
afterEach(async () => {
  await Promise.all(spawned.splice(0).map((client) => client.kill()));
});

/** Spawn `node -e <script>` through the client under test. */
function spawnScript(script: string, onStderrLine?: (line: string) => void) {
  const client = spawnAppServerClient({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: { ...process.env },
    onStderrLine,
  });
  spawned.push(client);
  return client;
}

/** True while the OS still knows about `pid`. Signal 0 only probes. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The child announces its own pid over the real notification channel.
 *
 * Placed EXPLICITLY in each script rather than prepended, because where it sits
 * is load-bearing: a test that needs the child's stdin already closed before the
 * parent writes uses the announcement as the proof that it is.
 */
const ANNOUNCE_PID = `process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"ready",params:{pid:process.pid}})+"\\n");`;

async function pidOf(client: {
  onNotification(
    handler: (n: { method: string; params?: unknown }) => void,
  ): void;
}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("child never announced its pid")),
      15_000,
    );
    client.onNotification((notification) => {
      if (notification.method !== "ready") return;
      clearTimeout(timer);
      resolve((notification.params as { pid: number }).pid);
    });
  });
}

describe("spawnAppServerClient teardown", () => {
  it("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    // SIGTERM is a request, and a child free to decline it would hold the
    // sandbox open for the life of the box.
    const client = spawnScript(
      `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); ${ANNOUNCE_PID}`,
    );
    const pid = await pidOf(client);
    expect(alive(pid)).toBe(true);

    await client.kill();
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("waits for the process even after a stream failure killed the client", async () => {
    /*
     * THE REGRESSION. A child that closes its stdin makes the next write EPIPE,
     * which fails the client instantly — correctly, because the turn racing
     * `exited` must not hang waiting for a corpse to fall over. But `kill()`
     * used to share that latch and return the moment the client was dead,
     * before the signal it had just sent was delivered or reaped.
     */
    const client = spawnScript(
      // fd 0 CLOSED, not `process.stdin.destroy()`: destroying the JS stream
      // leaves the descriptor open, the pipe keeps a reader, and the parent's
      // write is simply buffered — no EPIPE, and the test hangs instead of
      // reaching the state it is about. The announcement is last so that
      // receiving it proves the close already happened.
      `require("fs").closeSync(0); setInterval(() => {}, 1000); ${ANNOUNCE_PID}`,
    );
    const pid = await pidOf(client);

    // Write into the closed pipe. The rejection is the point: it proves the
    // client latched dead, which is the state `kill()` used to skip out of.
    await expect(client.request("initialize", {})).rejects.toThrow(
      /codex app-server exited/,
    );
    await expect(client.exited).resolves.toBeInstanceOf(Error);

    await client.kill();
    // The post-condition the old code did not hold: by the time teardown
    // returns, the process the next runtime would collide with is gone.
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("returns promptly once the child has already exited", async () => {
    // The fast path still exists — it just keys on the PROCESS now, so this
    // must not sit through the escalation timer.
    const client = spawnScript(`${ANNOUNCE_PID} process.exit(0);`);
    const pid = await pidOf(client);
    await client.exited;

    const started = Date.now();
    await client.kill();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("rejects in-flight requests when the child dies under them", async () => {
    // The failure this module is built around: Codex blocks on an unanswered
    // approval, so a promise left pending turns a crashed child into a hung
    // turn with no error anywhere.
    const client = spawnScript(
      `${ANNOUNCE_PID} setTimeout(() => process.exit(3), 150);`,
    );
    await pidOf(client);
    await expect(client.request("thread/start", {})).rejects.toThrow(/code=3/);
    await client.kill();
  }, 30_000);
});
