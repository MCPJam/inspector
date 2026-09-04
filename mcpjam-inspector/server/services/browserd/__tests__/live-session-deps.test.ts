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
  loadBrowserdBundle,
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
