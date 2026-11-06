import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBrowserProfileArchive } from "../../profile-archive";
import { prepareBrowserProfile } from "../prepare-browser-profile";
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
