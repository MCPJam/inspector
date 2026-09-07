import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginInstallAttempt,
  attemptStillOwns,
  claimStagingDirectory,
  PREVIOUS_SUFFIX,
  readRuntimeOperation,
  recoverInterruptedActivation,
  reserveRuntimeUse,
  resetRuntimeLifecycleForTests,
  runtimeUseState,
  STAGING_PREFIX,
  sweepAbandonedStaging,
  updateInstallAttempt,
  type RuntimeOperationKey,
} from "../runtime-lifecycle.js";

/**
 * Coordination between processes that share one runtime root.
 *
 * The properties here are the ones nothing enforced before: a second Inspector
 * joins an install rather than starting a second one; a killed installer leaves
 * a state somebody can retry from rather than a `downloading` that never moves;
 * a runtime in use is not replaced; and a staging directory is reclaimed only
 * when its owner is PROVABLY gone, never because it matched a prefix.
 *
 * The cross-process cases run real child processes. A same-process test cannot
 * express them: the thing under test is what one process concludes about
 * another's records, and faking the second process would be testing the fake.
 */

let base: string;
let key: RuntimeOperationKey;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-lifecycle-")));
  key = {
    runtimeRoot: join(base, "runtime"),
    harnessId: "claude-code",
    target: "linux-x64",
    packVersion: "test-1",
    treeDigest: `sha256:${"a".repeat(64)}`,
  };
  await mkdir(join(key.runtimeRoot, key.target), { recursive: true });
  resetRuntimeLifecycleForTests();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const installRoot = () => join(key.runtimeRoot, key.target);

/**
 * A child process that writes a record and then waits to be killed.
 *
 * Deliberately a real process: `ownerProvablyGone` asks the OS about a pid,
 * and the whole design rests on ESRCH being the only proof of absence.
 */
function spawnHolder(script: string): {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
} {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("READY")) resolve();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      reject(new Error(chunk.toString()));
    });
    child.on("exit", (code) => reject(new Error(`holder exited ${code}`)));
  });
  return { child, ready };
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("one install per identity", () => {
  it("gives the first caller the attempt and the second an observation", async () => {
    const first = await beginInstallAttempt(key);
    const second = await beginInstallAttempt(key);
    expect(first.kind).toBe("started");
    expect(second.kind).toBe("joined");
    // The SAME attempt, not a structurally equal one: two attempt ids would be
    // two extractions into one directory, which is the bug this prevents.
    expect(second.record.attemptId).toBe(first.record.attemptId);
  });

  it("does not let a build expecting a different pack join", async () => {
    // Two Inspectors, one updated. Joining would mean verifying bytes against
    // a digest they were never meant to satisfy.
    await beginInstallAttempt(key);
    const other = await beginInstallAttempt({
      ...key,
      treeDigest: `sha256:${"b".repeat(64)}`,
    });
    expect(other.kind).toBe("started");
  });

  it("lets a new attempt follow a terminal one", async () => {
    const first = await beginInstallAttempt(key);
    await updateInstallAttempt(key, first.record.attemptId, {
      state: "failed",
      reason: "network",
      message: "no",
    });
    const retry = await beginInstallAttempt(key);
    expect(retry.kind).toBe("started");
    expect(retry.record.attemptId).not.toBe(first.record.attemptId);
  });

  it("retains a terminal failure until somebody explicitly retries", async () => {
    const first = await beginInstallAttempt(key);
    await updateInstallAttempt(key, first.record.attemptId, {
      state: "failed",
      reason: "network",
      message: "the runtime pack could not be downloaded",
    });
    // Read repeatedly, as a poll would: the failure must not decay.
    for (let i = 0; i < 3; i += 1) {
      await expect(readRuntimeOperation(key)).resolves.toMatchObject({
        state: "failed",
        reason: "network",
      });
    }
  });

  it("ignores a progress write from a superseded attempt", async () => {
    const first = await beginInstallAttempt(key);
    await updateInstallAttempt(key, first.record.attemptId, {
      state: "failed",
      reason: "network",
      message: "no",
    });
    const retry = await beginInstallAttempt(key);
    // The loser reporting 90% must not overwrite the winner's state.
    await expect(
      updateInstallAttempt(key, first.record.attemptId, {
        state: "downloading",
        percent: 90,
      }),
    ).resolves.toBe(false);
    await expect(readRuntimeOperation(key)).resolves.toMatchObject({
      attemptId: retry.record.attemptId,
      state: "reserved",
    });
    await expect(
      attemptStillOwns(key, first.record.attemptId),
    ).resolves.toBe(false);
  });
});

describe("a second process", () => {
  it("joins the install another process is running, rather than starting one", async () => {
    // The holder writes the record directly rather than through the module:
    // the child is a bare Node with no TypeScript loader. The shape is the
    // module's own, and the same-process tests above cover that
    // `beginInstallAttempt` produces exactly this shape — so what this test
    // adds is the part only a second process can show, which is what one
    // process concludes about another's live record.
    const recordFile = join(installRoot(), ".mcpjam-operation.json");
    const holder = spawnHolder(`
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
        attemptId: "att_other_process",
        ownerPid: process.pid,
        ownerStartedAt: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
        harnessId: ${JSON.stringify(key.harnessId)},
        target: ${JSON.stringify(key.target)},
        packVersion: ${JSON.stringify(key.packVersion)},
        treeDigest: ${JSON.stringify(key.treeDigest)},
        state: "downloading",
        percent: 12,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }));
      console.log("READY");
      setInterval(() => {}, 1000);
    `);
    try {
      await holder.ready;
      const joined = await beginInstallAttempt(key);
      expect(joined).toMatchObject({
        kind: "joined",
        record: { attemptId: "att_other_process", percent: 12 },
      });
    } finally {
      holder.child.kill("SIGKILL");
      await waitForExit(holder.child);
    }
  });

  it("recovers an attempt whose owner was killed, as interrupted", async () => {
    const recordFile = join(installRoot(), ".mcpjam-operation.json");
    const holder = spawnHolder(`
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
        attemptId: "att_killed",
        ownerPid: process.pid,
        ownerStartedAt: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
        harnessId: ${JSON.stringify(key.harnessId)},
        target: ${JSON.stringify(key.target)},
        packVersion: ${JSON.stringify(key.packVersion)},
        treeDigest: ${JSON.stringify(key.treeDigest)},
        state: "downloading",
        percent: 40,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }));
      console.log("READY");
      setInterval(() => {}, 1000);
    `);
    await holder.ready;

    // While it lives, the attempt is live and nobody may take it.
    await expect(readRuntimeOperation(key)).resolves.toMatchObject({
      state: "downloading",
    });

    holder.child.kill("SIGKILL");
    await waitForExit(holder.child);

    // Dead: the record becomes a terminal state the UI can offer Retry from,
    // rather than a `downloading` that never moves again.
    await expect(readRuntimeOperation(key)).resolves.toMatchObject({
      attemptId: "att_killed",
      state: "interrupted",
    });
    await expect(beginInstallAttempt(key)).resolves.toMatchObject({
      kind: "started",
    });
  });
});

describe("a runtime in use is not replaced", () => {
  const versionRoot = () => join(base, "runtime", "linux-x64", "test-1");

  it("reports busy while a reservation is held", async () => {
    const reservation = await reserveRuntimeUse({
      key,
      runtimeRoot: versionRoot(),
      label: "session-1",
    });
    await expect(
      runtimeUseState({ key, runtimeRoot: versionRoot() }),
    ).resolves.toMatchObject({ busy: true, holders: [process.pid] });

    await reservation.release();
    await expect(
      runtimeUseState({ key, runtimeRoot: versionRoot() }),
    ).resolves.toMatchObject({ busy: false });
  });

  it("does not confuse one version's readers with another's", async () => {
    const reservation = await reserveRuntimeUse({
      key,
      runtimeRoot: versionRoot(),
    });
    await expect(
      runtimeUseState({ key, runtimeRoot: join(base, "runtime", "linux-x64", "test-2") }),
    ).resolves.toMatchObject({ busy: false });
    await reservation.release();
  });

  it("sees another process's reservation, and reclaims it only once it dies", async () => {
    const useDir = join(installRoot(), ".mcpjam-inuse");
    await mkdir(useDir, { recursive: true });
    const holder = spawnHolder(`
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      writeFileSync(join(${JSON.stringify(useDir)}, process.pid + "-x.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
          runtimeRoot: ${JSON.stringify(versionRoot())},
          at: Date.now(),
        }));
      console.log("READY");
      setInterval(() => {}, 1000);
    `);
    try {
      await holder.ready;
      const busy = await runtimeUseState({ key, runtimeRoot: versionRoot() });
      expect(busy.busy).toBe(true);
      expect(busy.holders).toContain(holder.child.pid);
    } finally {
      holder.child.kill("SIGKILL");
      await waitForExit(holder.child);
    }
    // Only now — and the stale reservation is swept as it is read.
    await expect(
      runtimeUseState({ key, runtimeRoot: versionRoot() }),
    ).resolves.toMatchObject({ busy: false });
  });
});

describe("staging is reclaimed only when provably abandoned", () => {
  it("leaves a live process's staging directory alone", async () => {
    const staging = join(installRoot(), `${STAGING_PREFIX}live`);
    await mkdir(staging, { recursive: true });
    const holder = spawnHolder(`
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      writeFileSync(join(${JSON.stringify(staging)}, ".mcpjam-staging-owner.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
          attemptId: "att_live",
          at: Date.now(),
        }));
      console.log("READY");
      setInterval(() => {}, 1000);
    `);
    try {
      await holder.ready;
      // The old sweep matched the prefix and deleted this — 500 MB out from
      // under another Inspector's running extraction.
      await expect(sweepAbandonedStaging(key)).resolves.toMatchObject({
        removed: 0,
        left: 1,
      });
      await expect(stat(staging)).resolves.toBeTruthy();
    } finally {
      holder.child.kill("SIGKILL");
      await waitForExit(holder.child);
    }
    await expect(sweepAbandonedStaging(key)).resolves.toMatchObject({
      removed: 1,
    });
  });

  it("leaves an unowned staging directory alone rather than guessing", async () => {
    // No ownership record: either a directory whose claim has not landed yet,
    // or one from an older build. Neither is provably abandoned.
    const staging = join(installRoot(), `${STAGING_PREFIX}unowned`);
    await mkdir(staging, { recursive: true });
    await expect(sweepAbandonedStaging(key)).resolves.toMatchObject({
      removed: 0,
      left: 1,
    });
  });

  it("records an owner when an attempt claims a directory", async () => {
    const staging = join(installRoot(), `${STAGING_PREFIX}mine`);
    await mkdir(staging, { recursive: true });
    await claimStagingDirectory({ staging, attemptId: "att_mine" });
    const owner = JSON.parse(
      await readFile(join(staging, ".mcpjam-staging-owner.json"), "utf8"),
    );
    expect(owner).toMatchObject({ pid: process.pid, attemptId: "att_mine" });
    // Ours, and alive: not swept.
    await expect(sweepAbandonedStaging(key)).resolves.toMatchObject({
      removed: 0,
    });
  });
});

describe("an interrupted activation", () => {
  const versionRoot = () => join(installRoot(), "test-1");

  it("puts back a runtime whose rename never completed", async () => {
    // The crash window: the old directory has been moved aside and the new one
    // was never renamed in. The machine has a perfectly good pack and reports
    // `absent`.
    const previous = `${versionRoot()}${PREVIOUS_SUFFIX}`;
    await mkdir(join(previous, "claude-code"), { recursive: true });
    await writeFile(join(previous, ".mcpjam-pack-installed.json"), "{}");

    await expect(
      recoverInterruptedActivation({ key, versionRoot: versionRoot() }),
    ).resolves.toBe(true);
    await expect(stat(join(versionRoot(), "claude-code"))).resolves.toBeTruthy();
    await expect(stat(previous)).rejects.toThrow();
  });

  it("discards a spent backup rather than clobbering a live runtime", async () => {
    // Activation completed and the crash was after the rename. The current
    // directory is the real one; the backup is genuinely spent.
    await mkdir(join(versionRoot(), "claude-code"), { recursive: true });
    await writeFile(join(versionRoot(), "marker"), "current");
    const previous = `${versionRoot()}${PREVIOUS_SUFFIX}`;
    await mkdir(previous, { recursive: true });
    await writeFile(join(previous, "marker"), "old");

    await expect(
      recoverInterruptedActivation({ key, versionRoot: versionRoot() }),
    ).resolves.toBe(false);
    await expect(
      readFile(join(versionRoot(), "marker"), "utf8"),
    ).resolves.toBe("current");
    await expect(stat(previous)).rejects.toThrow();
  });

  it("does nothing when there is nothing to recover", async () => {
    await expect(
      recoverInterruptedActivation({ key, versionRoot: versionRoot() }),
    ).resolves.toBe(false);
  });
});
