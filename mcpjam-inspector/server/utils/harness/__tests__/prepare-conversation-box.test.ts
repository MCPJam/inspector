import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  log: [] as string[],
  provision: vi.fn(),
  reserve: vi.fn(),
  renew: vi.fn(),
  release: vi.fn(),
  startLease: vi.fn(),
  claimLane: vi.fn(),
  fetchSecrets: vi.fn(),
  createProvider: vi.fn(),
}));

vi.mock("../../computers/control-plane-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  preparePlaygroundTerminalSandbox: mocks.provision,
}));
vi.mock("../harness-model-broker.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reserveHarnessBox: mocks.reserve,
  renewHarnessBoxReservation: mocks.renew,
  releaseHarnessBoxReservation: mocks.release,
  startHarnessModelBroker: mocks.startLease,
}));
vi.mock("../harness-session-state.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimHarnessSessionState: mocks.claimLane,
}));
vi.mock("../runtime-secrets.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRuntimeSecrets: mocks.fetchSecrets,
}));
vi.mock("../sandbox-provider-factory.js", () => ({
  createHarnessSandboxProvider: mocks.createProvider,
}));

import { harnessRecipeIdentity } from "../harness-bake";
import {
  COMMAND_BOUND_MS,
  hostedBootstrapRuntimes,
  prepareConversationBox,
} from "../prepare-conversation-box";
import { PREPARATION_DEADLINE_MS } from "../preparation-timing";

type Run = {
  command: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
};

const TTL_MS = 300_000;
const PROBE = "timeout --version";
const BOUNDED = /^timeout -s KILL 150 bash -c '/;
const isGuard = (command: string) => command.includes("command -v pnpm");
const isInstall = (command: string) =>
  command.includes("install") && !isGuard(command);

/**
 * A box the bootstrap runs against. `baked` answers every recipe marker;
 * otherwise the framework installs. `hang` makes the install wait on its
 * signal, as a long `pnpm install` does, until `finishInstall`; `installing`
 * settles once it runs. `guardMs` is how long the pnpm guard takes, and
 * `gnuTimeout: false` a box whose `timeout` is not coreutils'.
 */
function fakeBox(
  opts: {
    baked?: boolean;
    hang?: boolean;
    guardMs?: number;
    gnuTimeout?: boolean;
  } = {},
) {
  const runs: Run[] = [];
  const spawn = vi.fn();
  let installStarted = () => {};
  let finishInstall = () => {};
  const installing = new Promise<void>((resolve) => {
    installStarted = resolve;
  });
  const session = {
    readTextFile: vi.fn(async ({ path }: { path: string }) =>
      opts.baked && path.includes(".bootstrap-") ? "" : null,
    ),
    writeTextFile: vi.fn(async () => undefined),
    run: vi.fn(async (run: Run) => {
      // An aborted call never reaches the box, as with E2B's request signal.
      run.abortSignal?.throwIfAborted();
      runs.push(run);
      mocks.log.push("command");
      if (run.command === PROBE) {
        return opts.gnuTimeout === false
          ? { exitCode: 127, stdout: "", stderr: "timeout: not found" }
          : {
              exitCode: 0,
              stdout: "timeout (GNU coreutils) 9.4\n",
              stderr: "",
            };
      }
      if (isGuard(run.command) && opts.guardMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.guardMs));
      }
      if (opts.hang && isInstall(run.command)) {
        installStarted();
        await new Promise<void>((resolve, reject) => {
          finishInstall = resolve;
          run.abortSignal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      }
      return {
        exitCode: 0,
        stdout: run.command.includes("$HOME") ? "/home/user" : "",
        stderr: "",
      };
    }),
    spawn,
    restricted: () => session,
  };
  mocks.createProvider.mockImplementation(() => ({
    createSession: vi.fn(async () => session),
  }));
  return {
    runs,
    spawn,
    session,
    installing,
    finishInstall: () => finishInstall(),
  };
}

function prepare() {
  return prepareConversationBox({
    harnessId: "claude-code",
    projectId: "project_1",
    chatSessionId: "chat_1",
    modelId: "anthropic/claude-haiku-4.5",
    bearer: "member-bearer",
    authorization: async () => "Bearer fresh",
    cleanupAuthorization: async () => "Bearer cleanup",
  });
}

beforeEach(() => {
  mocks.log.length = 0;
  for (const mock of [
    mocks.provision,
    mocks.reserve,
    mocks.renew,
    mocks.release,
    mocks.startLease,
    mocks.claimLane,
    mocks.fetchSecrets,
    mocks.createProvider,
  ]) {
    mock.mockReset();
  }
  mocks.provision.mockImplementation(async () => {
    mocks.log.push("provision");
    return {
      ok: true,
      value: {
        outcome: "prepared",
        sandboxRowId: "row_1",
        sandboxId: "sbx_1",
        workdir: "/home/user",
        idleMs: 300_000,
      },
    };
  });
  mocks.reserve.mockImplementation(async () => {
    mocks.log.push("claim");
    return { ok: true, expiresAt: Date.now() + TTL_MS, ttlMs: TTL_MS };
  });
  mocks.renew.mockImplementation(async () => {
    mocks.log.push("renew");
    return { ok: true, ttlMs: TTL_MS };
  });
  mocks.release.mockImplementation(async () => {
    mocks.log.push("release");
    return { ok: true };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("preparing a new chat's box", () => {
  it("installs under the claim, every command bounded in the box, and nothing a Send owns runs", async () => {
    const box = fakeBox();
    await expect(prepare()).resolves.toEqual({ outcome: "prepared" });

    // The claim covers everything in the box, from the first call to the last.
    expect(mocks.log[0]).toBe("provision");
    expect(mocks.log[1]).toBe("claim");
    expect(mocks.log.at(-1)).toBe("release");
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        box: { kind: "sandbox", sandboxRowId: "row_1" },
        purpose: "prepare",
        bearer: "Bearer fresh",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mocks.release).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: mocks.reserve.mock.calls[0]![0].runId,
        bearer: "Bearer cleanup",
      }),
    );
    // Attached without the guard, which runs fenced; then the bootstrap,
    // every command under coreutils `timeout -s KILL`.
    expect(mocks.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sbx_1", skipPnpmGuard: true }),
    );
    expect(box.runs[0]!.command).toBe(PROBE);
    expect(isGuard(box.runs[1]!.command)).toBe(true);
    expect(box.runs.length).toBeGreaterThan(2);
    for (const run of box.runs.slice(1)) {
      expect(run.command).toMatch(BOUNDED);
    }

    // No lease, no lane, no bridge, no CLI.
    expect(mocks.startLease).not.toHaveBeenCalled();
    expect(mocks.claimLane).not.toHaveBeenCalled();
    expect(box.spawn).not.toHaveBeenCalled();
    // No secret anywhere: none read, none in the box's environment.
    expect(mocks.fetchSecrets).not.toHaveBeenCalled();
    for (const run of box.runs) {
      expect(Object.keys(run.env ?? {})).toEqual(
        run.env ? ["BOOTSTRAP_DIR"] : [],
      );
    }
    // The install itself: no MCP or skill files, only the recipes.
    for (const [write] of box.session.writeTextFile.mock.calls as unknown[][]) {
      expect((write as { path: string }).path).toMatch(
        /^\/home\/user\/\.ai-sdk-harness\/\.harness-bootstrap\//,
      );
    }
  });

  it("on a baked box only checks the markers", async () => {
    const box = fakeBox({ baked: true });
    await expect(prepare()).resolves.toEqual({ outcome: "prepared" });
    expect(box.session.writeTextFile).not.toHaveBeenCalled();
    expect(
      box.runs.slice(2).every((run) => run.command.includes("$HOME")),
    ).toBe(true);
  });

  it("skips a box whose timeout is not coreutils', and hands the claim back", async () => {
    const box = fakeBox({ gnuTimeout: false });
    await expect(prepare()).resolves.toEqual({
      outcome: "skipped",
      reason: "no_timeout",
    });
    expect(box.runs.map((run) => run.command)).toEqual([PROBE]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("renews the claim while it runs, stops when it is lost, and hands it back once the bound has passed", async () => {
    vi.useFakeTimers();
    const box = fakeBox({ hang: true });
    mocks.renew
      .mockImplementationOnce(async () => {
        mocks.log.push("renew");
        return { ok: true, ttlMs: TTL_MS };
      })
      .mockImplementation(async () => {
        mocks.log.push("renew");
        return { ok: false };
      });
    const prepared = prepare();
    await box.installing;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(prepared).resolves.toEqual({ outcome: "failed" });
    // No command started after the loss.
    const lostAt = mocks.log.lastIndexOf("renew");
    expect(mocks.log.slice(lostAt + 1)).not.toContain("command");
    expect(box.spawn).not.toHaveBeenCalled();
    // The interrupted install, started at the claim, may run until its bound
    // and the margin: not handed back before.
    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 30_000 - 120_000 - 1);
    expect(mocks.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("past its deadline hands the claim back once the interrupted command's bound has passed", async () => {
    vi.useFakeTimers();
    // The guard takes a minute, so the install starts a minute in.
    const box = fakeBox({ hang: true, guardMs: 60_000 });
    const prepared = prepare();
    await vi.advanceTimersByTimeAsync(60_000);
    await box.installing;
    await vi.advanceTimersByTimeAsync(PREPARATION_DEADLINE_MS - 60_000);
    await expect(prepared).resolves.toEqual({ outcome: "failed" });
    expect(mocks.release).not.toHaveBeenCalled();
    // Started at one minute, bounded at its bound and the margin after.
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(mocks.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("a failed command ended, so the box is handed back at once", async () => {
    const box = fakeBox();
    const run = box.session.run.getMockImplementation()!;
    box.session.run.mockImplementation(async (call: Run) => {
      const result = await run(call);
      return isInstall(call.command) ? { ...result, exitCode: 1 } : result;
    });
    await expect(prepare()).resolves.toEqual({ outcome: "failed" });
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("a command whose call dropped is handed back only once its bound has passed", async () => {
    vi.useFakeTimers();
    const box = fakeBox();
    const run = box.session.run.getMockImplementation()!;
    box.session.run.mockImplementation(async (call: Run) => {
      if (isInstall(call.command)) throw new Error("connection reset");
      return run(call);
    });
    await expect(prepare()).resolves.toEqual({ outcome: "failed" });
    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 30_000 - 1);
    expect(mocks.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("after a stall, starts nothing its claim might not outlive, by the clock and not a timer", async () => {
    vi.useFakeTimers();
    const box = fakeBox({ hang: true });
    const prepared = prepare();
    await box.installing;
    const started = box.runs.length;
    const written = box.session.writeTextFile.mock.calls.length;
    // The process stalls: the monotonic clock moves on, no timer fires.
    const fakeNow = performance.now.bind(performance);
    const stalled = vi
      .spyOn(performance, "now")
      .mockImplementation(() => fakeNow() + 4 * 60_000);
    try {
      box.finishInstall();
      await expect(prepared).resolves.toEqual({ outcome: "failed" });
    } finally {
      stalled.mockRestore();
    }
    expect(mocks.renew).not.toHaveBeenCalled();
    // Not the install's marker, nor anything after it.
    expect(box.runs).toHaveLength(started);
    expect(box.session.writeTextFile).toHaveBeenCalledTimes(written);
    // Nothing it started is still running, so the box is handed back.
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("starts nothing once unanswered renewals leave too little of the claim", async () => {
    vi.useFakeTimers();
    const box = fakeBox({ hang: true });
    mocks.renew.mockImplementation(() => new Promise(() => {}));
    const prepared = prepare();
    await box.installing;
    const started = box.runs.length;
    // Two minutes in, a command would end past the TTL the claim answered.
    await vi.advanceTimersByTimeAsync(125_000);
    expect(mocks.renew).toHaveBeenCalledTimes(2);
    box.finishInstall();
    await expect(prepared).resolves.toEqual({ outcome: "failed" });
    expect(box.runs).toHaveLength(started);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("an attach refused starts nothing, and hands the claim back at once", async () => {
    mocks.createProvider.mockImplementation(() => ({
      createSession: vi.fn(async () => {
        throw new Error("sandbox not found");
      }),
    }));
    await expect(prepare()).resolves.toEqual({ outcome: "failed" });
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("hands back a claim the backend may have made but never answered", async () => {
    fakeBox();
    mocks.reserve.mockResolvedValue({
      ok: false,
      status: 502,
      error: "Failed to reach harness model-broker endpoint",
    });
    await expect(prepare()).resolves.toEqual({
      outcome: "skipped",
      reason: "box_busy",
    });
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });

  it("runs nothing on a box another run has claimed", async () => {
    fakeBox();
    mocks.reserve.mockResolvedValue({ ok: false, status: 409, error: "busy" });
    await expect(prepare()).resolves.toEqual({
      outcome: "skipped",
      reason: "box_busy",
    });
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("answers a backend skip with its reason, and touches no box", async () => {
    mocks.provision.mockResolvedValue({
      ok: true,
      value: { outcome: "skipped", reason: "capacity" },
    });
    await expect(prepare()).resolves.toEqual({
      outcome: "skipped",
      reason: "capacity",
    });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });

  it("reads a backend without the preparation's route as switched off", async () => {
    mocks.provision.mockResolvedValue({
      ok: false,
      status: 404,
      error: "request failed (404)",
    });
    await expect(prepare()).resolves.toEqual({
      outcome: "skipped",
      reason: "disabled",
    });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});

describe("the recipes a preparation applies", () => {
  // The identities the computer template bakes: a prepared box is one a Send
  // finds already installed, warm or cold.
  const locked = JSON.parse(
    readFileSync(
      new URL("../../../../harness-bake.lock.json", import.meta.url),
      "utf8",
    ),
  ) as { recipes: Array<{ harnessId: string; identity: string }> };

  it.each(["claude-code", "codex"] as const)(
    "are the ones the template bakes for %s",
    async (harnessId) => {
      const identities = await Promise.all(
        hostedBootstrapRuntimes(harnessId, "anthropic/claude-haiku-4.5").map(
          async (runtime) =>
            harnessRecipeIdentity((await runtime.getBootstrap!({}))!),
        ),
      );
      expect(new Set(identities)).toEqual(
        new Set(
          locked.recipes
            .filter((recipe) => recipe.harnessId === harnessId)
            .map((recipe) => recipe.identity),
        ),
      );
    },
  );
});
