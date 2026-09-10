import { ipcMain, BrowserWindow, autoUpdater, app } from "electron";
import log from "electron-log";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "pending"; version?: string; installRequested: boolean }
  | { kind: "downloaded"; version: string; releaseNotes?: string }
  // Auto-update announced a newer version and then failed to produce an
  // installable build. The button stays, but it now sends the user to the
  // releases page instead of pretending an install is one click away.
  | { kind: "manual"; version?: string };

// Watchdog for a `pending` that is not going anywhere.
//
// Two timeouts, because "the user is staring at a spinner" and "a download is
// quietly running in the background" deserve different patience. Both are
// exposed as `let` so tests can shorten them.
//
// INSTALL: the user clicked and is waiting. Five minutes covers a 100MB+
// macOS update on a sluggish link; longer than that is a stall, not slow
// network.
export const DEFAULT_STALLED_INSTALL_TIMEOUT_MS = 5 * 60_000;
// DOWNLOAD: nobody clicked, so we can wait longer — but not forever. Before
// this existed a download that started and never landed left the Update
// button on screen for the life of the process with nothing behind it.
export const DEFAULT_STALLED_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
let stalledInstallTimeoutMs = DEFAULT_STALLED_INSTALL_TIMEOUT_MS;
let stalledDownloadTimeoutMs = DEFAULT_STALLED_DOWNLOAD_TIMEOUT_MS;

// How many collapsed downloads it takes before we stop offering the in-app
// install at all. One collapse can be a dropped connection; the next poll
// deserves a chance. Two is a pattern — that install cannot self-update, and
// re-arming the button just gives the user something to click that will never
// work (BUG: 17 clicks in 124 seconds, INSPECTOR desktop 2.45.0).
const MANUAL_FALLBACK_AFTER_COLLAPSES = 2;

let currentStatus: UpdateStatus = { kind: "idle" };
let isQuittingForUpdate = false;
let isCheckingOrDownloading = false;
let trustedWindow: BrowserWindow | null = null;
let updateListenersRegistered = false;
let stalledInstallTimer: ReturnType<typeof setTimeout> | null = null;
let collapsedDownloads = 0;

function clearStalledInstallWatchdog(): void {
  if (stalledInstallTimer !== null) {
    clearTimeout(stalledInstallTimer);
    stalledInstallTimer = null;
  }
}

function startStalledInstallWatchdog(timeoutMs: number): void {
  clearStalledInstallWatchdog();
  stalledInstallTimer = setTimeout(() => {
    stalledInstallTimer = null;
    // Re-check at fire-time: if anything succeeded or moved on, do nothing.
    if (currentStatus.kind === "pending") {
      // Always audible: a watchdog firing means nothing at all came back,
      // which the user cannot discover any other way.
      collapsePendingDownload(`no progress for ${timeoutMs}ms`, {
        alwaysNotify: true,
      });
    }
  }, timeoutMs);
}

/**
 * A `pending` that will never become `downloaded`, retired.
 *
 * Called from every event that means "this check is over and it did not hand
 * us an installable build": `update-not-available`, `error`, and the
 * watchdog. Retiring it is the whole point — the shipped bug was that
 * `pending` was treated as sticky, so a download that died left a live
 * "Update" pill wired to nothing. Clicking it set `installRequested`, the
 * next updater event cleared it, and the label flickered `Update → Updating…
 * → Update` forever with no error and no progress.
 *
 * On macOS the two events are not the matched pair they look like:
 * `update-available` is a KVO side effect of SQRLUpdater entering its
 * Downloading state, while `update-not-available` is *this check* completing
 * without a `SQRLDownloadedUpdate` in hand (see Electron's
 * auto_updater_mac.mm). A download that starts and then dies without an
 * NSError produces exactly `update-available` … `update-not-available`, which
 * is why the sticky-pending path was reachable at all.
 */
function collapsePendingDownload(
  reason: string,
  // Notify even when the collapse is still recoverable. Callers that saw a
  // real updater `error` in a packaged build pass true, so the "always tell
  // packaged users" rule from the earlier fix survives this change.
  { alwaysNotify = false }: { alwaysNotify?: boolean } = {},
): void {
  if (currentStatus.kind !== "pending") {
    return;
  }
  clearStalledInstallWatchdog();
  // Squirrel's own state is independent of this flag, so clearing it only
  // means "a later check may run again".
  isCheckingOrDownloading = false;
  const userWasWaiting = currentStatus.installRequested;
  const version = currentStatus.version;
  collapsedDownloads += 1;
  log.error(
    `Update download collapsed (${reason}); collapse #${collapsedDownloads}, user waiting: ${userWasWaiting}`,
  );

  // Someone who clicked is owed an answer now, not on the next poll.
  const goesManual =
    userWasWaiting || collapsedDownloads >= MANUAL_FALLBACK_AFTER_COLLAPSES;
  // One collapse can be a dropped connection: drop back to idle and let
  // update-electron-app's next poll try again. What must NOT happen is
  // staying in `pending`, which is what left a live button wired to a
  // download that had already died.
  setStatus(goesManual ? { kind: "manual", version } : { kind: "idle" });
  if (goesManual || alwaysNotify) {
    broadcastUpdateError();
  }
}

function isTrustedSender(senderId: number): boolean {
  return (
    trustedWindow !== null &&
    !trustedWindow.isDestroyed() &&
    senderId === trustedWindow.webContents.id
  );
}

export function setTrustedUpdateWindow(window: BrowserWindow): void {
  trustedWindow = window;

  if (currentStatus.kind === "idle") {
    return;
  }

  if (window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed()) {
        window.webContents.send("update-status", currentStatus);
      }
    });
    return;
  }

  window.webContents.send("update-status", currentStatus);
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("update-status", currentStatus);
    }
  }
}

function broadcastUpdateError(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("update-error");
    }
  }
}

function setStatus(next: UpdateStatus): void {
  currentStatus = next;
  broadcast();
}

export function setupAutoUpdaterEvents(): void {
  autoUpdater.on("checking-for-update", () => {
    isCheckingOrDownloading = true;
    log.info("Checking for updates...");
  });

  autoUpdater.on("update-available", () => {
    isCheckingOrDownloading = true;
    // Once an install has proven it cannot apply an update, re-arming the
    // in-app button on the next poll just hands the user the same dead
    // control again. `manual` already points them somewhere that works, so
    // it outranks a fresh `update-available` for the rest of the session.
    if (currentStatus.kind === "manual") {
      log.info(
        "Update available, but auto-update already failed on this install — keeping the manual download",
      );
      return;
    }
    log.info("Update available, downloading...");
    const installRequested =
      currentStatus.kind === "pending" ? currentStatus.installRequested : false;
    setStatus({ kind: "pending", installRequested });
    // Armed on ENTERING pending, not only when the user clicks: a download
    // that dies quietly used to leave the button up for the life of the
    // process with nothing behind it.
    startStalledInstallWatchdog(
      installRequested ? stalledInstallTimeoutMs : stalledDownloadTimeoutMs,
    );
  });

  autoUpdater.on("update-not-available", () => {
    isCheckingOrDownloading = false;
    log.info("No updates available");
    // A `pending` that ends here produced no installable build — retire it.
    // A `downloaded` one is real and survives a later check; `manual` has
    // already told the user where to go.
    if (currentStatus.kind === "pending") {
      collapsePendingDownload("update-not-available");
      return;
    }
    if (currentStatus.kind === "idle") {
      setStatus({ kind: "idle" });
      return;
    }
    log.info(
      `Keeping visible update status after update-not-available: ${currentStatus.kind}`,
    );
  });

  autoUpdater.on("error", (error) => {
    isCheckingOrDownloading = false;
    clearStalledInstallWatchdog();
    log.error("Auto-updater error:", error);
    const wasQuittingForUpdate = isQuittingForUpdate;
    isQuittingForUpdate = false;

    // Always notify users in packaged builds — Bug 2: previously we only
    // broadcast when the user had clicked, so download failures before any
    // click silently swallowed the error and the button kept inviting clicks.
    const shouldNotifyUser = app.isPackaged || wasQuittingForUpdate;

    // Same retirement as update-not-available: the download is over and it
    // did not deliver. collapsePendingDownload() owns the broadcast.
    if (currentStatus.kind === "pending") {
      collapsePendingDownload("updater error", {
        alwaysNotify: shouldNotifyUser,
      });
      return;
    }

    if (
      currentStatus.kind === "downloaded" ||
      currentStatus.kind === "manual"
    ) {
      setStatus(currentStatus);
    } else {
      setStatus({ kind: "idle" });
    }

    if (shouldNotifyUser) {
      broadcastUpdateError();
    }
  });

  autoUpdater.on("update-downloaded", (_event, releaseNotes, releaseName) => {
    isCheckingOrDownloading = false;
    clearStalledInstallWatchdog();
    // A build that actually landed clears the history that pushed us to the
    // manual fallback — `downloaded` always wins.
    collapsedDownloads = 0;
    log.info(`Update downloaded: ${releaseName}`);
    const installRequested =
      currentStatus.kind === "pending" ? currentStatus.installRequested : false;
    setStatus({
      kind: "downloaded",
      version: releaseName || "new version",
      releaseNotes: releaseNotes || "",
    });
    if (installRequested && !isQuittingForUpdate) {
      log.info("User had requested install — restarting now");
      isQuittingForUpdate = true;
      try {
        autoUpdater.quitAndInstall();
      } catch (error) {
        // quitAndInstall can throw on macOS when the staged build is
        // mis-signed or Squirrel's staging dir is corrupted. Don't leave the
        // quitting flag stuck — surface the error so the user can retry.
        log.error("quitAndInstall threw:", error);
        isQuittingForUpdate = false;
        broadcastUpdateError();
      }
    }
  });
}

export function registerUpdateListeners(mainWindow: BrowserWindow): void {
  setTrustedUpdateWindow(mainWindow);

  if (updateListenersRegistered) {
    return;
  }
  updateListenersRegistered = true;

  ipcMain.handle("app:get-update-status", (event) => {
    if (!isTrustedSender(event.sender.id)) {
      log.warn(
        `Ignoring get-update-status from untrusted sender (id: ${event.sender.id})`,
      );
      return { kind: "idle" } satisfies UpdateStatus;
    }
    return currentStatus;
  });

  ipcMain.on("app:restart-for-update", (event) => {
    if (!isTrustedSender(event.sender.id)) {
      log.warn(
        `Ignoring restart-for-update from untrusted sender (id: ${event.sender.id})`,
      );
      return;
    }
    if (currentStatus.kind === "downloaded") {
      // The same guard `update-downloaded` and `installUpdateOnQuit` already
      // carry, and this handler is the one that was missing it. `quitAndInstall`
      // is NOT idempotent: with a window still open Electron registers this
      // AutoUpdater on the window list and waits for the windows to close, so a
      // second call re-registers the same observer and Chromium reports
      // "Observers can only be added once!" via DumpWithoutCrashing
      // (INSPECTOR-ELECTRON-GT).
      //
      // Nothing here clears the status, so the button stays live for the whole
      // teardown — which is exactly the window a double-click lands in. The
      // renderer disables it too; this is the half that also covers a resend
      // from anywhere else.
      if (isQuittingForUpdate) {
        log.info("Install already underway — ignoring repeat restart request");
        return;
      }
      log.info("Restarting app to install update...");
      isQuittingForUpdate = true;
      try {
        autoUpdater.quitAndInstall();
      } catch (error) {
        log.error("quitAndInstall threw:", error);
        isQuittingForUpdate = false;
        broadcastUpdateError();
      }
    } else if (currentStatus.kind === "pending") {
      log.info("Update still downloading — queuing install for completion");
      setStatus({ ...currentStatus, installRequested: true });
      // Re-arm on the shorter, someone-is-watching timeout: if neither
      // `update-downloaded` nor `error` fires within stalledInstallTimeoutMs,
      // treat as stalled (Bug 1).
      startStalledInstallWatchdog(stalledInstallTimeoutMs);
      if (!isCheckingOrDownloading) {
        try {
          isCheckingOrDownloading = true;
          autoUpdater.checkForUpdates();
        } catch (error) {
          log.error("Failed to retry update check:", error);
          collapsePendingDownload("checkForUpdates threw");
        }
      }
    } else if (currentStatus.kind === "manual") {
      // The renderer sends the user to the releases page instead of firing
      // this, so reaching it means a stale click raced the status change.
      // Re-broadcast rather than no-op: silence is the bug we are fixing.
      log.info(
        "Restart requested but auto-update is unavailable on this install",
      );
      broadcastUpdateError();
    } else {
      log.info("Restart requested but no update is staged");
    }
  });

  if (!app.isPackaged) {
    ipcMain.on("app:simulate-update", (event) => {
      if (!isTrustedSender(event.sender.id)) {
        log.warn(
          `Ignoring simulate-update from untrusted sender (id: ${event.sender.id})`,
        );
        return;
      }
      log.info("Simulating update available (dev mode)");
      setStatus({ kind: "pending", installRequested: false });
      startStalledInstallWatchdog(stalledDownloadTimeoutMs);
    });

    ipcMain.on("app:simulate-update-downloaded", (event) => {
      if (!isTrustedSender(event.sender.id)) {
        log.warn(
          `Ignoring simulate-update-downloaded from untrusted sender (id: ${event.sender.id})`,
        );
        return;
      }
      log.info("Simulating update downloaded (dev mode)");
      const installRequested =
        currentStatus.kind === "pending" && currentStatus.installRequested;
      setStatus({
        kind: "downloaded",
        version: "99.0.0",
        releaseNotes: "Simulated update for testing",
      });
      if (installRequested) {
        log.info("User had requested install — would restart now (dev mode)");
      }
    });

    ipcMain.on("app:simulate-update-error", (event) => {
      if (!isTrustedSender(event.sender.id)) {
        log.warn(
          `Ignoring simulate-update-error from untrusted sender (id: ${event.sender.id})`,
        );
        return;
      }
      log.error("Auto-updater error:", new Error("Simulated update failure"));
      clearStalledInstallWatchdog();
      // Mirrors the real handler so QA sees the shipped retirement path —
      // including the second collapse that flips the pill to the manual
      // download.
      if (currentStatus.kind === "pending") {
        collapsePendingDownload("simulated updater error");
        return;
      }
      if (
        currentStatus.kind === "downloaded" ||
        currentStatus.kind === "manual"
      ) {
        setStatus(currentStatus);
      } else {
        setStatus({ kind: "idle" });
      }
    });
  }
}

export function installUpdateOnQuit(): boolean {
  if (!app.isPackaged) {
    return false;
  }
  if (currentStatus.kind === "downloaded" && !isQuittingForUpdate) {
    log.info("Staged update found at quit — installing before exit");
    isQuittingForUpdate = true;
    try {
      autoUpdater.quitAndInstall();
      return true;
    } catch (error) {
      // Same failure mode as the click-path quitAndInstall guards: a
      // mis-signed staged build or corrupted Squirrel staging dir can
      // throw synchronously. Don't trap the user in a quit-loop — log and
      // fall through to the normal shutdown path. The window may already
      // be tearing down so we don't bother broadcasting.
      log.error("installUpdateOnQuit: quitAndInstall threw:", error);
      isQuittingForUpdate = false;
      return false;
    }
  }
  return false;
}

// Test-only reset
export function __resetUpdateStateForTests(): void {
  clearStalledInstallWatchdog();
  currentStatus = { kind: "idle" };
  isQuittingForUpdate = false;
  isCheckingOrDownloading = false;
  trustedWindow = null;
  updateListenersRegistered = false;
  collapsedDownloads = 0;
  stalledInstallTimeoutMs = DEFAULT_STALLED_INSTALL_TIMEOUT_MS;
  stalledDownloadTimeoutMs = DEFAULT_STALLED_DOWNLOAD_TIMEOUT_MS;
}

// Test-only timeout override so the watchdog test doesn't have to advance
// a full minute of fake timers.
export function __setStalledInstallTimeoutForTests(ms: number): void {
  stalledInstallTimeoutMs = ms;
}

export function __setStalledDownloadTimeoutForTests(ms: number): void {
  stalledDownloadTimeoutMs = ms;
}
