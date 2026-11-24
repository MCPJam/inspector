import { readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { importBrowserProfileArchive } from "../profile-archive";
import type { BrowserdConfig } from "./config";

/** Restore before launch and remove the delivered archive in either mode. */
export async function prepareBrowserProfile(
  config: Pick<BrowserdConfig, "profileArchivePath" | "userDataDir"> &
    Partial<Pick<BrowserdConfig, "freshProfile" | "recordDir">>,
): Promise<boolean> {
  if (config.freshProfile) await emptyProfileDir(config);
  if (!config.profileArchivePath) return false;
  try {
    try {
      const archive = await readFile(config.profileArchivePath);
      await importBrowserProfileArchive(
        config.userDataDir,
        new Uint8Array(archive),
      );
    } finally {
      await rm(config.profileArchivePath, { force: true });
    }
  } catch (cause) {
    throw new Error(
      "Saved profile could not be loaded. Save the profile again and retry.",
      { cause },
    );
  }
  return true;
}

/**
 * Remove everything an earlier boot left in the profile directory. An archive
 * import only adds files, so without this a fresh profile would still carry
 * the cookies and storage of whoever used this box before. Recordings kept
 * under the directory stay, since an earlier run may not have collected its
 * own yet.
 */
async function emptyProfileDir(
  config: Pick<BrowserdConfig, "userDataDir"> &
    Partial<Pick<BrowserdConfig, "recordDir">>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(config.userDataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const kept = config.recordDir
    ? relative(config.userDataDir, config.recordDir).split(/[\\/]/)[0]
    : undefined;
  for (const entry of entries) {
    if (entry === kept) continue;
    await rm(join(config.userDataDir, entry), { recursive: true, force: true });
  }
}
