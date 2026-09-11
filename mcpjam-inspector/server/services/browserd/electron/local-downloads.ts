import type { Session, DownloadItem } from "electron";
import { mkdtempSync, chmodSync } from "node:fs";
import {
  rm,
  rename,
  copyFile,
  readdir,
  lstat,
  mkdtemp,
} from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { LocalBrowserSecurityPolicy } from "../local/security-policy.js";
import { logger } from "../../../utils/logger.js";

export const LOCAL_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
let dialogPending = false;
let stagingCleanup: Promise<void> | undefined;
export function cleanAbandonedLocalDownloads(): Promise<void> {
  return (stagingCleanup ??= (async () => {
    for (const name of await readdir(tmpdir())) {
      const match = /^mcpjam-browser-download-(\d+)-/.exec(name);
      if (!match || Number(match[1]) === process.pid) continue;
      try {
        process.kill(Number(match[1]), 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      const path = join(tmpdir(), name);
      const stat = await lstat(path).catch(() => undefined);
      if (
        stat?.isDirectory() &&
        !stat.isSymbolicLink() &&
        (process.getuid === undefined || stat.uid === process.getuid())
      )
        await rm(path, { recursive: true, force: true });
    }
  })().catch(() => {}));
}
export function installLocalDownloads(
  session: Session,
  getPolicy: () => LocalBrowserSecurityPolicy | undefined,
): () => void {
  let active: DownloadItem | undefined;
  const listener = (
    _event: Electron.Event,
    item: DownloadItem,
    contents: Electron.WebContents,
  ) => {
    const policy = getPolicy();
    if (
      !policy?.isActive() ||
      active ||
      dialogPending ||
      item.getTotalBytes() > LOCAL_DOWNLOAD_MAX_BYTES ||
      !item.getURLChain().every((url) => policy.allowsRequest(url))
    ) {
      item.cancel();
      return;
    }
    active = item;
    dialogPending = true;
    item.pause();
    let directory: string;
    try {
      directory = mkdtempSync(
        join(tmpdir(), `mcpjam-browser-download-${process.pid}-`),
      );
      chmodSync(directory, 0o700);
      item.setSavePath(join(directory, "download"));
    } catch {
      active = undefined;
      dialogPending = false;
      item.cancel();
      return;
    }
    const staged = join(directory, "download");
    let destination: string | undefined;
    let finished = false;
    const cancel = () => {
      if (!finished) item.cancel();
    };
    const unsubscribe = policy.onRevoked(cancel);
    contents.once("destroyed", cancel);
    const timer = setTimeout(cancel, 60_000);
    timer.unref?.();
    const cleanup = async () => {
      clearTimeout(timer);
      unsubscribe();
      contents.removeListener("destroyed", cancel);
      if (active === item) active = undefined;
      await rm(directory, { force: true, recursive: true });
    };
    item.on("updated", () => {
      if (
        !policy.isActive() ||
        item.getReceivedBytes() > LOCAL_DOWNLOAD_MAX_BYTES
      )
        cancel();
    });
    item.once("done", async (_event, state) => {
      finished = true;
      try {
        if (
          state === "completed" &&
          destination &&
          item.getReceivedBytes() <= LOCAL_DOWNLOAD_MAX_BYTES
        ) {
          await policy.assertActive();
          try {
            await rename(staged, destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
            // Publish atomically on the destination volume too. Never expose
            // a partially copied file if permission changes during the copy.
            const adjacent = await mkdtemp(
              join(dirname(destination), ".mcpjam-download-"),
            );
            try {
              const candidate = join(adjacent, "download");
              await copyFile(staged, candidate);
              await policy.assertActive();
              await rename(candidate, destination);
            } finally {
              await rm(adjacent, { recursive: true, force: true });
            }
          }
          logger.info("Local browser download completed");
        }
      } catch {
        logger.warn("Local browser download could not be saved");
      } finally {
        await cleanup();
      }
    });
    void (async () => {
      try {
        const { dialog, BrowserWindow } = await import("electron");
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.isVisible() && !window.isDestroyed(),
        );
        if (!window) {
          cancel();
          return;
        }
        let source = "this page";
        try {
          source = new URL(item.getURL()).origin;
        } catch {}
        const result = await dialog.showSaveDialog(window, {
          title: `Save download from ${source}`,
          defaultPath:
            basename(item.getFilename()).replace(/[\u0000-\u001f]/g, "_") ||
            "download",
          buttonLabel: "Save download",
          properties: ["showOverwriteConfirmation"],
        });
        if (
          finished ||
          result.canceled ||
          !result.filePath ||
          !policy.isActive()
        ) {
          cancel();
          return;
        }
        await policy.assertActive();
        destination = result.filePath;
        clearTimeout(timer);
        item.resume();
      } catch {
        cancel();
      } finally {
        dialogPending = false;
      }
    })();
  };
  session.on("will-download", listener);
  return () => {
    active?.cancel();
    session.removeListener("will-download", listener);
  };
}
