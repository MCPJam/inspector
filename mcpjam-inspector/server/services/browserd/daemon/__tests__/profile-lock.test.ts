import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, readlink, writeFile, readdir, mkdir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { clearStaleSingletonLock, probeSingletonOwner } from "../profile-lock";

/**
 * A throwaway profile directory that is actually thrown away.
 *
 * Every block below needs one, and each `mkdtemp` left one behind — nine per
 * run, forever. One recorder and one file-scope `afterEach` beats remembering
 * to clean up in each new test.
 */
const scratchDirs: string[] = [];
async function lockDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "browserd-lock-"));
  scratchDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("clearStaleSingletonLock (L8)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "browserd-profile-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes the singleton files an ungraceful kill left behind", async () => {
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      await writeFile(join(dir, f), "stale");
    }
    await writeFile(join(dir, "Cookies"), "keep me"); // a real profile file
    const result = await clearStaleSingletonLock(dir);
    expect(result.removed.sort()).toEqual([
      "SingletonCookie",
      "SingletonLock",
      "SingletonSocket",
    ]);
    expect(result.failed).toEqual([]);
    // only the singleton files went; real profile data is untouched
    expect(await readdir(dir)).toEqual(["Cookies"]);
  });

  it("is a no-op on a clean profile (nothing to clear is success)", async () => {
    const result = await clearStaleSingletonLock(dir);
    expect(result).toEqual({ removed: [], failed: [] });
  });

  it("reports (does not throw) a singleton it cannot remove", async () => {
    // A directory named SingletonLock cannot be unlink()ed → surfaces in failed.
    await mkdir(join(dir, "SingletonLock"));
    const result = await clearStaleSingletonLock(dir);
    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe("SingletonLock");
  });
});

describe("probeSingletonOwner — is anyone actually using this profile?", () => {
  it("reports a live owner when the lock names this host and a running pid", async () => {
    const dir = await lockDir();
    await symlink(`${hostname()}-4242`, join(dir, "SingletonLock"));
    expect(await probeSingletonOwner(dir, () => true)).toEqual({
      live: true,
      pid: 4242,
    });
  });

  it("reports a dead pid as clearable debris", async () => {
    const dir = await lockDir();
    await symlink(`${hostname()}-4242`, join(dir, "SingletonLock"));
    expect(await probeSingletonOwner(dir, () => false)).toEqual({
      live: false,
      pid: 4242,
    });
  });

  it("treats ANOTHER host's lock as in use, not as debris", async () => {
    // A shared home directory over NFS: the pid is real, on a machine whose
    // process table this one cannot see. `process.kill` here would be asking
    // about a local process that happens to share the number — so the honest
    // answer is "held", and clearing it would launch a second browser into a
    // profile already open elsewhere.
    const dir = await lockDir();
    await symlink("some-other-box-4242", join(dir, "SingletonLock"));
    // The local liveness probe is not even consulted.
    expect(await probeSingletonOwner(dir, () => false)).toEqual({
      live: true,
      pid: 4242,
      host: "some-other-box",
    });
  });

  it("treats a missing or unreadable lock as free", async () => {
    const dir = await lockDir();
    expect(await probeSingletonOwner(dir, () => true)).toEqual({ live: false });
  });
});

describe("clearing a lock is not a licence to take a live profile", () => {
  it("removes nothing when the probe finds a live owner at unlink time", async () => {
    // The window this closes: the session layer checked a moment ago and
    // decided to launch. A browser that took the profile in between would have
    // had its lock files removed out from under it.
    const dir = await lockDir();
    await symlink(`${hostname()}-4242`, join(dir, "SingletonLock"));

    const cleared = await clearStaleSingletonLock(dir, async () => ({
      live: true,
      pid: 4242,
    }));

    expect(cleared.removed).toEqual([]);
    expect(cleared.heldBy).toEqual({ pid: 4242 });
    // Still there: the owner's, not ours.
    expect(await readlink(join(dir, "SingletonLock"))).toContain("4242");
  });

  it("clears debris when the probe says nobody is there", async () => {
    const dir = await lockDir();
    await symlink(`${hostname()}-4242`, join(dir, "SingletonLock"));

    const cleared = await clearStaleSingletonLock(dir, async () => ({
      live: false,
      pid: 4242,
    }));

    expect(cleared.removed).toEqual(["SingletonLock"]);
    expect(cleared.heldBy).toBeUndefined();
  });
});

describe("probeSingletonOwner — a live pid is not yet an owner", () => {
  it("clears the lock when the pid was RECYCLED by something else", async () => {
    // The wedge this pins. An ungraceful exit leaves `SingletonLock` behind;
    // after a reboot its pid routinely belongs to an unrelated process. Taken
    // as the owner, the profile refused every launch forever, and the only
    // recovery was deleting the symlink by hand.
    const dir = await lockDir();
    await symlink(`${hostname()}-4242`, join(dir, "SingletonLock"));

    expect(
      await probeSingletonOwner(
        dir,
        () => true,
        () => "postgres",
      ),
    ).toEqual({ live: false, pid: 4242 });
  });

  it("keeps the lock when a browser really is holding it", async () => {
    const dir = await lockDir();
    await symlink(`${hostname()}-4242`, join(dir, "SingletonLock"));

    for (const command of [
      "chrome",
      "Google Chrome",
      "chromium",
      "headless_shell",
    ]) {
      expect(
        await probeSingletonOwner(
          dir,
          () => true,
          () => command,
        ),
      ).toEqual({ live: true, pid: 4242 });
    }
  });

  it("keeps the lock when the process cannot be identified at all", async () => {
    // No `ps`, Windows, or the process vanishing mid-probe. Learning nothing
    // must not become permission to delete somebody's profile, so the pid
    // check stands alone — the behaviour that existed before.
    const dir = await lockDir();
    await symlink(`${hostname()}-4242`, join(dir, "SingletonLock"));

    expect(
      await probeSingletonOwner(
        dir,
        () => true,
        () => undefined,
      ),
    ).toEqual({ live: true, pid: 4242 });
  });
});

describe("probeSingletonOwner — what counts as having ASKED", () => {
  it("does not read empty output as a confirmed non-browser", async () => {
    // `""` is a reading we failed to take, not one that came back negative.
    // Treated as the latter it cleared the lock of a live process, which is
    // the exact confusion the rest of this probe is built to avoid.
    const dir = await mkdtemp(join(tmpdir(), "browserd-lock-"));
    await symlink(`${hostname()}-4242`, join(dir, "SingletonLock"));

    for (const answer of ["", "   ", "\n"]) {
      expect(
        await probeSingletonOwner(
          dir,
          () => true,
          () => answer,
        ),
      ).toEqual({ live: true, pid: 4242 });
    }
  });

  it("keeps the lock for Chromium browsers that are not called Chrome", async () => {
    // Saying "not a browser" about a real one deletes a running browser's
    // singleton files. Brave, Edge and the desktop app itself are all
    // Chromium, and none of them carries `chrom` in the name `ps` reports.
    const dir = await mkdtemp(join(tmpdir(), "browserd-lock-"));
    await symlink(`${hostname()}-4242`, join(dir, "SingletonLock"));

    for (const command of [
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/MCPJam.app/Contents/MacOS/Electron",
      "firefox",
    ]) {
      expect(
        await probeSingletonOwner(
          dir,
          () => true,
          () => command,
        ),
      ).toEqual({ live: true, pid: 4242 });
    }
  });

  it("still clears a lock a genuinely unrelated process holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "browserd-lock-"));
    await symlink(`${hostname()}-4242`, join(dir, "SingletonLock"));

    expect(
      await probeSingletonOwner(
        dir,
        () => true,
        () => "postgres",
      ),
    ).toEqual({ live: false, pid: 4242 });
  });
});
