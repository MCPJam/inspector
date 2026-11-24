import { readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { importBrowserProfileArchive } from "../profile-archive";
import type { BrowserdConfig } from "./config";
import { probeSingletonOwner } from "./profile-lock";

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
 * the cookies and storage of whoever used this box before. The recordings
 * directory stays, since an earlier run may not have collected its own yet,
 * and nothing beside it does.
 *
 * A browser still running on the directory keeps it: emptying it would delete
 * a live profile under that browser, so the boot stops instead.
 */
async function emptyProfileDir(
  config: Pick<BrowserdConfig, "userDataDir"> &
    Partial<Pick<BrowserdConfig, "recordDir">>,
): Promise<void> {
  const owner = await probeSingletonOwner(config.userDataDir);
  if (owner.live) {
    throw new Error(
      `profile_in_use: another browser (pid ${owner.pid ?? "unknown"}` +
        `${owner.host ? ` on ${owner.host}` : ""}) holds this profile; close it and try again`,
    );
  }
  const kept = config.recordDir
    ? relative(config.userDataDir, config.recordDir)
    : "";
  const keep =
    kept && !kept.startsWith("..") && !isAbsolute(kept) ? kept.split(sep) : [];
  await emptyExcept(config.userDataDir, keep);
}

/** Empty `dir`, keeping only the path `keep` names below it. */
async function emptyExcept(dir: string, keep: readonly string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry === keep[0]) {
      // On the way to the recordings: keep this one, empty what's beside it.
      if (keep.length > 1) await emptyExcept(join(dir, entry), keep.slice(1));
      continue;
    }
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}
