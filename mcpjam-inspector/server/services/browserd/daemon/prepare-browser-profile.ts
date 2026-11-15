import { readFile, rm } from "node:fs/promises";
import { importBrowserProfileArchive } from "../profile-archive";
import type { BrowserdConfig } from "./config";

/** Restore before launch and remove the delivered archive in either mode. */
export async function prepareBrowserProfile(
  config: Pick<BrowserdConfig, "profileArchivePath" | "userDataDir">,
): Promise<boolean> {
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
