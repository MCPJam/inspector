import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBrowserProfileArchive } from "../../profile-archive";
import {
  prepareBrowserProfile,
  withProfileClaim,
} from "../prepare-browser-profile";
import { readBrowserdConfig } from "../config";

const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "browserd-import-"));
  dirs.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "Default"), { recursive: true });
  await writeFile(join(source, "Default", "Cookies"), "signed-in cookies");
  const archivePath = join(root, "profile.tar.gz");
  await writeFile(archivePath, await exportBrowserProfileArchive(source));
  return { archivePath, userDataDir: join(root, "target") };
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("prepareBrowserProfile", () => {
  it.each(["persistent", "ephemeral"])(
    "imports and deletes the archive in %s mode",
    async (mode) => {
      const { archivePath, userDataDir } = await fixture();
      const config = readBrowserdConfig({
        MCPJAM_BROWSERD_EPHEMERAL: String(mode === "ephemeral"),
        MCPJAM_BROWSERD_PROFILE_ARCHIVE: archivePath,
        MCPJAM_BROWSERD_USER_DATA_DIR: userDataDir,
        MCPJAM_BROWSERD_TOKEN: "test-token",
      });
      expect(config.contextMode).toBe(mode);
      expect(await prepareBrowserProfile(config)).toBe(true);
      expect(
        await readFile(join(userDataDir, "Default", "Cookies"), "utf8"),
      ).toBe("signed-in cookies");
      await expect(readFile(archivePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("starts a fresh profile from an empty directory, keeping recordings", async () => {
    const { archivePath, userDataDir } = await fixture();
    const earlier = async () => {
      await mkdir(join(userDataDir, "Default", "Local Storage"), { recursive: true });
      await writeFile(join(userDataDir, "Default", "Login Data"), "someone else's sign-ins");
      await writeFile(join(userDataDir, "Default", "Local Storage", "000003.log"), "their storage");
      await mkdir(join(userDataDir, "recordings"), { recursive: true });
      await writeFile(join(userDataDir, "recordings", "run.mp4"), "an earlier run's video");
    };
    const env = {
      MCPJAM_BROWSERD_USER_DATA_DIR: userDataDir,
      MCPJAM_BROWSERD_TOKEN: "test-token",
      MCPJAM_BROWSERD_FRESH_PROFILE: "1",
    };

    // With the account's archive: only the archive's files remain.
    await earlier();
    expect(
      await prepareBrowserProfile(
        readBrowserdConfig({ ...env, MCPJAM_BROWSERD_PROFILE_ARCHIVE: archivePath }),
      ),
    ).toBe(true);
    expect(await readFile(join(userDataDir, "Default", "Cookies"), "utf8")).toBe("signed-in cookies");
    await expect(readFile(join(userDataDir, "Default", "Login Data"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(userDataDir, "Default", "Local Storage", "000003.log")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Without one: a blank profile.
    await earlier();
    expect(await prepareBrowserProfile(readBrowserdConfig(env))).toBe(false);
    await expect(readFile(join(userDataDir, "Default", "Cookies"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(userDataDir, "Default", "Login Data"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(userDataDir, "recordings", "run.mp4"), "utf8")).toBe("an earlier run's video");
  });

  it("leaves a profile a live browser holds, rather than empty it under that browser", async () => {
    const { userDataDir } = await fixture();
    await mkdir(join(userDataDir, "Default"), { recursive: true });
    await writeFile(join(userDataDir, "Default", "Login Data"), "a running browser's sign-ins");
    // Another machine's lock is a live owner this process can't rule out.
    await symlink("another-host-4242", join(userDataDir, "SingletonLock"));
    await expect(
      prepareBrowserProfile(
        readBrowserdConfig({
          MCPJAM_BROWSERD_USER_DATA_DIR: userDataDir,
          MCPJAM_BROWSERD_TOKEN: "test-token",
          MCPJAM_BROWSERD_FRESH_PROFILE: "1",
        }),
      ),
    ).rejects.toThrow(/^profile_in_use: /);
    expect(await readFile(join(userDataDir, "Default", "Login Data"), "utf8")).toBe("a running browser's sign-ins");
  });

  it("keeps only the recordings folder when it sits inside a profile folder", async () => {
    const { userDataDir } = await fixture();
    const recordDir = join(userDataDir, "Default", "recordings");
    await mkdir(recordDir, { recursive: true });
    await writeFile(join(userDataDir, "Default", "Cookies"), "someone else's cookies");
    await writeFile(join(recordDir, "run.mp4"), "an earlier run's video");
    expect(
      await prepareBrowserProfile(
        readBrowserdConfig({
          MCPJAM_BROWSERD_USER_DATA_DIR: userDataDir,
          MCPJAM_BROWSERD_TOKEN: "test-token",
          MCPJAM_BROWSERD_FRESH_PROFILE: "1",
          MCPJAM_BROWSERD_RECORD_DIR: recordDir,
        }),
      ),
    ).toBe(false);
    await expect(readFile(join(userDataDir, "Default", "Cookies"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(recordDir, "run.mp4"), "utf8")).toBe("an earlier run's video");
  });

  it("refuses a fresh profile whose recordings folder is the profile itself", async () => {
    const { userDataDir } = await fixture();
    await mkdir(userDataDir, { recursive: true });
    await writeFile(join(userDataDir, "run.mp4"), "an earlier run's video");
    await expect(
      prepareBrowserProfile(
        readBrowserdConfig({
          MCPJAM_BROWSERD_USER_DATA_DIR: userDataDir,
          MCPJAM_BROWSERD_TOKEN: "test-token",
          MCPJAM_BROWSERD_FRESH_PROFILE: "1",
          MCPJAM_BROWSERD_RECORD_DIR: userDataDir,
        }),
      ),
    ).rejects.toThrow(/is the profile directory itself/);
    expect(await readFile(join(userDataDir, "run.mp4"), "utf8")).toBe(
      "an earlier run's video",
    );
  });

  it.runIf(process.platform === "linux")(
    "lets one boot at a time start a browser on a profile",
    async () => {
      const { userDataDir } = await fixture();
      let holding!: () => void;
      const held = new Promise<void>((resolve) => (holding = resolve));
      let release!: () => void;
      const first = withProfileClaim(userDataDir, () => {
        holding();
        return new Promise<void>((resolve) => (release = resolve));
      });
      await held;
      // A second boot on this profile stops before it empties anything.
      const second = vi.fn(async () => "second");
      await expect(withProfileClaim(userDataDir, second)).rejects.toThrow(
        /^profile_in_use/,
      );
      expect(second).not.toHaveBeenCalled();
      // Another profile is another claim.
      await expect(
        withProfileClaim(`${userDataDir}-other`, async () => "other"),
      ).resolves.toBe("other");
      release();
      await first;
      await expect(
        withProfileClaim(userDataDir, async () => "after"),
      ).resolves.toBe("after");
    },
  );

  it("keeps an earlier boot's profile when a fresh one isn't asked for", async () => {
    const { userDataDir } = await fixture();
    await mkdir(join(userDataDir, "Default"), { recursive: true });
    await writeFile(join(userDataDir, "Default", "Login Data"), "the person's sign-ins");
    expect(
      await prepareBrowserProfile(
        readBrowserdConfig({ MCPJAM_BROWSERD_USER_DATA_DIR: userDataDir, MCPJAM_BROWSERD_TOKEN: "test-token" }),
      ),
    ).toBe(false);
    expect(await readFile(join(userDataDir, "Default", "Login Data"), "utf8")).toBe("the person's sign-ins");
  });

  it("does nothing without an archive", async () => {
    expect(await prepareBrowserProfile({ userDataDir: "/unused" })).toBe(false);
  });

  it("fails closed and deletes a corrupt archive", async () => {
    const { archivePath, userDataDir } = await fixture();
    await writeFile(archivePath, "corrupt");
    await expect(
      prepareBrowserProfile({ profileArchivePath: archivePath, userDataDir }),
    ).rejects.toThrow("Saved profile could not be loaded");
    await expect(readFile(archivePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when the delivered archive is missing", async () => {
    await expect(
      prepareBrowserProfile({
        profileArchivePath: "/missing/profile.tar.gz",
        userDataDir: "/unused",
      }),
    ).rejects.toThrow("Saved profile could not be loaded");
  });
});
