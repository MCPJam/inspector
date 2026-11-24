import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
 * a live profile under that browser, so the boot stops instead. A browser
 * that another boot starts after this check can't lose its files to this
 * cleanup either, because every boot runs inside `withProfileClaim`.
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
  if (config.recordDir && !kept) {
    // Keeping the whole directory would keep its sign-ins too.
    throw new Error(
      "MCPJAM_BROWSERD_RECORD_DIR is the profile directory itself. Set it to a folder inside or outside the profile.",
    );
  }
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

/**
 * Run `boot` holding this machine's claim on the profile directory: from
 * before the fresh-profile cleanup until the browser holds its own lock. Two
 * daemons booting on one directory take turns, so neither can empty it while
 * the other's browser starts there, and the later one then finds that
 * browser's lock. The claim is an abstract socket, which the kernel releases
 * when its process dies, so a killed boot leaves nothing behind.
 */
export async function withProfileClaim<T>(
  userDataDir: string,
  boot: () => Promise<T>,
): Promise<T> {
  const claim = await takeProfileClaim(userDataDir);
  try {
    return await boot();
  } finally {
    claim?.close();
  }
}

async function takeProfileClaim(
  userDataDir: string,
): Promise<Server | undefined> {
  // Abstract sockets are Linux only; elsewhere the boot goes on unclaimed.
  if (process.platform !== "linux") return undefined;
  const id = createHash("sha256").update(resolve(userDataDir)).digest("hex");
  const server = createServer();
  try {
    await new Promise<void>((listening, failed) => {
      server.once("error", failed);
      server.listen(`\0mcpjam-browserd-profile-${id}`, listening);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    throw new Error(
      "profile_in_use: another browser is starting on this profile; try again",
    );
  }
  server.unref();
  return server;
}
