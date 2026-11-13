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
  hostedBootstrapRuntimes,
  PREPARATION_DEADLINE_MS,
  prepareConversationBox,
} from "../prepare-conversation-box";

type Run = {
  command: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
};

/**
 * A box the bootstrap runs against. `baked` answers every recipe marker;
 * otherwise the framework installs. `hang` makes the install wait on its
 * signal, as a long `pnpm install` does, until `finishInstall`; `installing`
 * settles once it runs.
 */
function fakeBox(opts: { baked?: boolean; hang?: boolean } = {}) {
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
      if (opts.hang && run.command.includes("install")) {
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
    return { ok: true, expiresAt: Date.now() + 900_000 };
  });
  mocks.renew.mockImplementation(async () => {
    mocks.log.push("renew");
    return { ok: true };
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
  it("installs under the claim, and nothing a Send owns runs", async () => {
    const box = fakeBox();
    await expect(prepare()).resolves.toEqual({ outcome: "prepared" });

    // The claim covers every sandbox command, from the first to the last.
    expect(mocks.log[0]).toBe("provision");
    expect(mocks.log[1]).toBe("claim");
    expect(mocks.log.at(-1)).toBe("release");
    expect(
      mocks.log.filter((step) => step === "command").length,
    ).toBeGreaterThan(0);
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        box: { kind: "sandbox", sandboxRowId: "row_1" },
        purpose: "prepare",
        bearer: "Bearer fresh",
      }),
    );
    expect(mocks.release).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: mocks.reserve.mock.calls[0]![0].runId,
        bearer: "Bearer cleanup",
      }),
    );

    // No lease, no lane, no bridge, no CLI.
    expect(mocks.startLease).not.toHaveBeenCalled();
    expect(mocks.claimLane).not.toHaveBeenCalled();
    expect(box.spawn).not.toHaveBeenCalled();
    // No secret anywhere: none read, none in the box's environment.
    expect(mocks.fetchSecrets).not.toHaveBeenCalled();
    expect(mocks.createProvider).toHaveBeenCalledWith({
      sandboxId: "sbx_1",
      commandTimeoutMs: PREPARATION_DEADLINE_MS,
    });
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
    expect(box.runs.every((run) => run.command.includes("$HOME"))).toBe(true);
  });

  it("renews the claim while it runs, and stops when the claim is lost", async () => {
    vi.useFakeTimers();
    const box = fakeBox({ hang: true });
    mocks.renew
      .mockImplementationOnce(async () => {
        mocks.log.push("renew");
        return { ok: true };
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
    // The claim is someone else's now: never released from here, and no
    // command started after the loss.
    expect(mocks.release).not.toHaveBeenCalled();
    const lostAt = mocks.log.lastIndexOf("renew");
    expect(mocks.log.slice(lostAt + 1)).not.toContain("command");
    expect(box.spawn).not.toHaveBeenCalled();
  });

  it("past its deadline leaves the claim to expire rather than free the box under a running command", async () => {
    vi.useFakeTimers();
    const box = fakeBox({ hang: true });
    const prepared = prepare();
    await box.installing;
    await vi.advanceTimersByTimeAsync(PREPARATION_DEADLINE_MS);
    await expect(prepared).resolves.toEqual({ outcome: "failed" });
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("a failed command ended, so the box is handed back", async () => {
    const box = fakeBox();
    box.session.run.mockImplementation(async (run: Run) => ({
      exitCode: run.command.includes("$HOME") ? 0 : 1,
      stdout: run.command.includes("$HOME") ? "/home/user" : "",
      stderr: "",
    }));
    await expect(prepare()).resolves.toEqual({ outcome: "failed" });
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("a command whose call dropped may still be running, so the claim is left to expire", async () => {
    const box = fakeBox();
    box.session.run.mockImplementation(async (run: Run) => {
      if (!run.command.includes("$HOME")) throw new Error("connection reset");
      return { exitCode: 0, stdout: "/home/user", stderr: "" };
    });
    await expect(prepare()).resolves.toEqual({ outcome: "failed" });
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("after a stall, starts nothing its claim might not outlive, by the clock and not a timer", async () => {
    vi.useFakeTimers();
    const box = fakeBox({ hang: true });
    const prepared = prepare();
    await box.installing;
    const started = box.runs.length;
    const written = box.session.writeTextFile.mock.calls.length;
    // The process stalls: the clock moves on, no timer fires, nothing renews.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    box.finishInstall();
    await expect(prepared).resolves.toEqual({ outcome: "failed" });
    expect(mocks.renew).not.toHaveBeenCalled();
    // Not the install's marker, nor anything after it.
    expect(box.runs).toHaveLength(started);
    expect(box.session.writeTextFile).toHaveBeenCalledTimes(written);
    // Nothing it started is still running, so the box is handed back.
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("starts nothing once a renewal goes unanswered past one interval and one call", async () => {
    vi.useFakeTimers();
    const box = fakeBox({ hang: true });
    mocks.renew.mockImplementation(() => new Promise(() => {}));
    const prepared = prepare();
    await box.installing;
    const started = box.runs.length;
    await vi.advanceTimersByTimeAsync(80_000);
    expect(mocks.renew).toHaveBeenCalledTimes(1);
    box.finishInstall();
    await expect(prepared).resolves.toEqual({ outcome: "failed" });
    expect(box.runs).toHaveLength(started);
    expect(mocks.release).toHaveBeenCalledTimes(1);
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
