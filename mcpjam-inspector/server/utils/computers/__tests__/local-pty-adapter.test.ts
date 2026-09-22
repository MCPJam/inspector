import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPtyWithCwd } from "../create-pty.js";
import { createLocalPtyCreator } from "../local-pty-adapter.js";
import type { NodePtyModule, NodePtyProcess } from "../local-pty.js";

/**
 * The adapter exists so the local terminal can reuse `createPtyWithCwd`. Each
 * assertion below pins one place where node-pty's contract differs from E2B's
 * — the differences are the whole reason this is not a pass-through.
 */

const realDir = mkdtempSync(join(tmpdir(), "mcpjam-pty-adapter-"));
afterAll(() => rmSync(realDir, { recursive: true, force: true }));

function fakePty(overrides: Partial<NodePtyProcess> = {}) {
  const dataListeners: Array<(d: string) => void> = [];
  const proc: NodePtyProcess = {
    pid: 4242,
    onData: (listener) => {
      dataListeners.push(listener);
      return { dispose: () => {} };
    },
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    ...overrides,
  };
  return { proc, emit: (s: string) => dataListeners.forEach((l) => l(s)) };
}

function moduleWith(spawn: NodePtyModule["spawn"]): NodePtyModule {
  return { spawn };
}

type SpawnArgs = Parameters<NodePtyModule["spawn"]>;

/** A spawn mock whose `mock.calls` keeps node-pty's argument tuple. */
function spawnMock(proc: NodePtyProcess) {
  return vi.fn((..._args: SpawnArgs) => proc);
}

const baseOpts = {
  cols: 80,
  rows: 24,
  timeoutMs: 3_600_000,
  onData: () => {},
};

describe("createLocalPtyCreator", () => {
  it("spawns the configured shell with the allowlisted env and geometry", async () => {
    const { proc } = fakePty();
    const spawn = spawnMock(proc);
    const creator = createLocalPtyCreator({
      ptyModule: moduleWith(spawn),
      shell: "/bin/zsh",
      env: { PATH: "/usr/bin", HOME: "/home/me" },
    });

    await creator.pty.create({ ...baseOpts, cwd: realDir });

    expect(spawn).toHaveBeenCalledWith("/bin/zsh", [], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: realDir,
      env: { PATH: "/usr/bin", HOME: "/home/me" },
    });
  });

  it("IGNORES timeoutMs — an E2B sandbox TTL has no local analogue", async () => {
    const { proc } = fakePty();
    const spawn = spawnMock(proc);
    const creator = createLocalPtyCreator({
      ptyModule: moduleWith(spawn),
      shell: "/bin/bash",
      env: {},
    });

    await creator.pty.create({ ...baseOpts, cwd: realDir });

    const options = spawn.mock.calls[0]![2] as Record<string, unknown>;
    expect(options).not.toHaveProperty("timeoutMs");
  });

  it("converts node-pty's string output into bytes", async () => {
    const { proc, emit } = fakePty();
    const chunks: Uint8Array[] = [];
    const creator = createLocalPtyCreator({
      ptyModule: moduleWith(() => proc),
      shell: "/bin/bash",
      env: {},
    });

    await creator.pty.create({
      ...baseOpts,
      cwd: realDir,
      onData: (bytes) => chunks.push(bytes),
    });
    emit("héllo");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(chunks[0]!).toString("utf8")).toBe("héllo");
  });

  it("REJECTS on a missing cwd — node-pty would hand back an instantly-dead shell", async () => {
    const spawn = spawnMock(fakePty().proc);
    const creator = createLocalPtyCreator({
      ptyModule: moduleWith(spawn),
      shell: "/bin/bash",
      env: {},
    });

    await expect(
      creator.pty.create({ ...baseOpts, cwd: join(realDir, "gone") })
    ).rejects.toThrow(/working directory/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("turns a SYNCHRONOUS spawn throw into a rejection", async () => {
    const creator = createLocalPtyCreator({
      ptyModule: moduleWith(() => {
        throw new Error("posix_spawnp failed");
      }),
      shell: "/nope/bash",
      env: {},
    });

    await expect(
      creator.pty.create({ ...baseOpts, cwd: realDir })
    ).rejects.toThrow("posix_spawnp failed");
  });
});

describe("createPtyWithCwd over the adapter", () => {
  it("falls back to a cwd-less spawn when the workspace dir is gone", async () => {
    const { proc } = fakePty();
    const spawn = spawnMock(proc);
    const creator = createLocalPtyCreator({
      ptyModule: moduleWith(spawn),
      shell: "/bin/bash",
      env: {},
    });

    // This is the behavior the pre-check buys: without a rejection,
    // createPtyWithCwd's retry never fires and the user gets a dead terminal.
    const handle = await createPtyWithCwd(
      creator,
      baseOpts,
      join(realDir, "vanished")
    );

    expect(handle).toBe(proc);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![2]).not.toHaveProperty("cwd");
  });

  it("keeps the cwd when it exists", async () => {
    const { proc } = fakePty();
    const spawn = spawnMock(proc);
    const creator = createLocalPtyCreator({
      ptyModule: moduleWith(spawn),
      shell: "/bin/bash",
      env: {},
    });

    await createPtyWithCwd(creator, baseOpts, realDir);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![2]).toMatchObject({ cwd: realDir });
  });
});
