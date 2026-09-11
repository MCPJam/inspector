/**
 * The pure halves of the live seam file. The E2B/stream halves are
 * VALIDATE-ON-STAGING by design; what IS testable here is the bundle
 * identity (the bytes the ensure path uploads and the hash the session row
 * pins) and the sandbox adapters the debug probe shares.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  adaptSandbox,
  browserdBundleHash,
  ensureStreamOn,
  loadBrowserdBundle,
  readBinaryFileFrom,
  writeBundleInto,
} from "../live-session-deps";

describe("live-session-deps — bundle identity", () => {
  it("hashes exactly the bytes it uploads", () => {
    const bytes = loadBrowserdBundle();
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(browserdBundleHash()).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    // Cached: identical references on repeat calls.
    expect(loadBrowserdBundle()).toBe(bytes);
  });
});

describe("live-session-deps — sandbox adapters", () => {
  it("adapts run/getHost to the boot recipe's surface", async () => {
    const kill = vi.fn();
    const wait = vi.fn();
    const run = vi.fn(async () => ({ kill, wait }));
    const sandbox = {
      commands: { run },
      files: { write: vi.fn(), makeDir: vi.fn() },
      getHost: (port: number) => `${port}-box.example`,
    };
    const adapted = adaptSandbox(sandbox);
    const onStdout = () => {};
    const handle = await adapted.runBackground("node x.mjs", {
      envs: { A: "1" },
      onStdout,
    });
    expect(run).toHaveBeenCalledWith("node x.mjs", {
      background: true,
      envs: { A: "1" },
      timeoutMs: 0,
      onStdout,
    });
    await handle.kill();
    await handle.wait();
    expect(kill).toHaveBeenCalled();
    expect(wait).toHaveBeenCalled();
    expect(adapted.getHost(8791)).toBe("8791-box.example");
  });

  it("creates the parent dir idempotently and writes the exact bytes", async () => {
    const writes: Array<[string, ArrayBuffer]> = [];
    const sandbox = {
      commands: { run: vi.fn() },
      files: {
        write: vi.fn(async (path: string, data: ArrayBuffer) => {
          writes.push([path, data]);
        }),
        makeDir: vi.fn(async () => {
          throw new Error("already exists");
        }),
      },
      getHost: () => "box.example",
    };
    const content = new Uint8Array([7, 8, 9]);
    await writeBundleInto(sandbox, "/opt/mcpjam/mcpjam-browserd.mjs", content);
    expect(sandbox.files.makeDir).toHaveBeenCalledWith("/opt/mcpjam");
    expect(writes).toHaveLength(1);
    expect(new Uint8Array(writes[0][1])).toEqual(content);
  });
});

describe("live-session-deps — desktop stream", () => {
  /**
   * `@e2b/desktop`'s VNCServer, in the one detail that matters: the password is
   * MINTED by `start()` and kept in memory. An instance that did not start the
   * stream has no password to report, which is what `getAuthKey()` throws about.
   */
  function fakeStream(over: { alreadyRunning?: boolean } = {}) {
    const state = { running: over.alreadyRunning ?? false, starts: 0 };
    let password: string | null = null;
    return {
      state,
      stream: {
        start: vi.fn(async () => {
          if (state.running) throw new Error("Stream is already running");
          state.starts += 1;
          state.running = true;
          password = `key-${state.starts}`;
        }),
        getAuthKey: () => {
          if (!password) {
            throw new Error(
              "Unable to retrieve stream auth key, check if requireAuth is enabled",
            );
          }
          return password;
        },
        getUrl: () => "https://box-6080.e2b.dev/vnc.html",
      },
    };
  }

  function fakeSandbox(
    stream: unknown,
    state?: { running: boolean; starts: number },
  ) {
    const ran: string[] = [];
    return {
      ran,
      sandbox: {
        stream,
        commands: {
          run: vi.fn(async (command: string) => {
            ran.push(command);
            // The reset kills x11vnc, which is what `checkVNCRunning()` sees.
            if (state && command.includes("pkill x11vnc")) {
              state.running = false;
            }
            return { exitCode: 0 };
          }),
        },
        files: { write: vi.fn(), makeDir: vi.fn() },
        getHost: (port: number) => `box-${port}.e2b.dev`,
      } as never,
    };
  }

  it("returns the URL and the key it just minted", async () => {
    const { stream } = fakeStream();
    const { sandbox, ran } = fakeSandbox(stream);
    expect(await ensureStreamOn(sandbox)).toEqual({
      streamUrl: "https://box-6080.e2b.dev/vnc.html",
      streamPassword: "key-1",
    });
    expect(ran).toEqual([]); // nothing to reset on a cold box
  });

  it("resets and restarts a stream an earlier process left running", async () => {
    // The failure this fixes: the surviving stream's password lives in a
    // process that is gone, so `getAuthKey()` throws and the model's
    // `browser_navigate` fails.
    const { stream, state } = fakeStream({ alreadyRunning: true });
    const { sandbox, ran } = fakeSandbox(stream, state);
    const result = await ensureStreamOn(sandbox);
    expect(ran[0]).toContain("pkill x11vnc");
    expect(ran[0]).toContain("novnc_proxy");
    expect(result.streamPassword).toBe("key-1");
    expect(state.running).toBe(true);
  });

  it("surfaces any other start failure instead of resetting the box", async () => {
    const { stream } = fakeStream();
    stream.start = vi.fn(async () => {
      throw new Error("Could not start noVNC server");
    });
    const { sandbox, ran } = fakeSandbox(stream);
    await expect(ensureStreamOn(sandbox)).rejects.toThrow(
      /Could not start noVNC server/,
    );
    expect(ran).toEqual([]);
  });

  it("refuses a sandbox with no stream API rather than guessing", async () => {
    const { sandbox } = fakeSandbox(undefined);
    await expect(ensureStreamOn(sandbox)).rejects.toThrow(
      /desktop stream API unavailable/,
    );
  });
});

/**
 * R-3. Reading a recording off the box.
 *
 * THROWS where `readTextFileFrom` swallows, and the difference is what the
 * caller does with the answer: a missing token means "boot a daemon yourself",
 * a missing recording means a run has lost its evidence. Swallowing the second
 * into `undefined` would make it indistinguishable from a run that was never
 * recorded.
 */
describe("live-session-deps — binary reads", () => {
  const sandboxWith = (files: Record<string, unknown>) =>
    ({
      commands: { run: vi.fn() },
      files: { write: vi.fn(), makeDir: vi.fn(), ...files },
      getHost: () => "host",
    }) as never;

  it("asks for BYTES, not text", async () => {
    // Without the format the SDK decodes as text, and an MP4 through a UTF-8
    // decoder is a corrupt file that still looks like a successful read.
    const read = vi.fn(async () => new Uint8Array([0, 1, 2]));

    const bytes = await readBinaryFileFrom(
      sandboxWith({ read }),
      "/rec/run-1.mp4",
    );

    expect(read).toHaveBeenCalledWith("/rec/run-1.mp4", { format: "bytes" });
    expect(Array.from(bytes)).toEqual([0, 1, 2]);
  });

  it("raises a missing file instead of answering with nothing", async () => {
    const read = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    await expect(
      readBinaryFileFrom(sandboxWith({ read }), "/rec/run-1.mp4"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("refuses an SDK that ignored the format rather than re-encoding", async () => {
    // Guessing an encoding for video bytes produces a plausible-looking file
    // that will not play, which is worse than no file at all.
    const read = vi.fn(async () => "not-bytes");
    await expect(
      readBinaryFileFrom(sandboxWith({ read }), "/rec/run-1.mp4"),
    ).rejects.toThrow(/returned text/);
  });

  it("refuses an adapter with no read at all", async () => {
    await expect(
      readBinaryFileFrom(sandboxWith({}), "/rec/run-1.mp4"),
    ).rejects.toThrow(/cannot read/);
  });
});
