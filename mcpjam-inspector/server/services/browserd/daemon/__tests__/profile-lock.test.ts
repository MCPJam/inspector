import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStaleSingletonLock } from "../profile-lock";

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
