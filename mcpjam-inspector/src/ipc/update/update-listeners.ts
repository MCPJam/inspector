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

// A refused EXTRA check, not a failed download.
//
// update-electron-app polls `checkForUpdates()` on a blind 10-minute
// `setInterval`, and Electron's CheckForUpdates has no dedupe of its own.
// Squirrel's `checkForUpdatesCommand` is a RACCommand with
// `allowsConcurrentExecution = NO`, so a poll that lands mid-download is
// refused on the spot and errors in `RACCommandErrorDomain`.
//
// That error describes the POLL, not the download: the download is still
// running and can still land. Collapsing on it would tell a user on a slow
// link that the update failed — a ~137MB macOS build has to sustain about
// 1.9 Mbit/s just to beat the interval — and after two of them it would
// retire the in-app install for a download that was working fine. The
// watchdog is the backstop for a download that really is stuck.
const CONCURRENT_CHECK_ERROR_DOMAIN = "RACCommandErrorDomain";
// Windows has no NSError domain. Squirrel.Windows refuses the very same
// overlapping poll from `spawnUpdate`, which throws a plain Error that
// Electron re-emits verbatim, so the message is the only thing that tells it
// apart from a download that really failed.
const CONCURRENT_CHECK_MESSAGE = /AutoUpdater process .* is already running/i;

function isRefusedConcurrentCheck(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { domain, message } = error as { domain?: unknown; message?: unknown };
  return (
    domain === CONCURRENT_CHECK_ERROR_DOMAIN ||
    (typeof message === "string" && CONCURRENT_CHECK_MESSAGE.test(message))
  );
}

let currentStatus: UpdateStatus = { kind: "idle" };
let isQuittingForUpdate = false;
let trustedWindow: BrowserWindow | null = null;
let updateListenersRegistered = false;
let stalledInstallTimer: ReturnType<typeof setTimeout> | null = null;
// Absolute deadline for the download that is currently `pending`. One per
// download: a click may bring it forward, never push it out.
let stalledDownloadDeadline: number | null = null;
let collapsedDownloads = 0;

function clearStalledInstallWatchdog(): void {
  if (stalledInstallTimer !== null) {
    clearTimeout(stalledInstallTimer);
    stalledInstallTimer = null;
  }
  stalledDownloadDeadline = null;
}

function startStalledInstallWatchdog(timeoutMs: number): void {
  const now = Date.now();
  // A click means "someone is watching now", not "start the clock over". If
  // the download already has a deadline the click can only bring it forward,
  // otherwise clicking at minute 19 of a 20-minute budget buys five more.
  const remaining =
    stalledDownloadDeadline === null ? null : stalledDownloadDeadline - now;
  const effectiveMs =
    remaining === null
      ? timeoutMs
      : Math.max(Math.min(remaining, timeoutMs), 0);
  clearStalledInstallWatchdog();
  stalledDownloadDeadline = now + effectiveMs;
  stalledInstallTimer = setTimeout(() => {
    stalledInstallTimer = null;
    stalledDownloadDeadline = null;
    // Re-check at fire-time: if anything succeeded or moved on, do nothing.
    if (currentStatus.kind === "pending") {
      // Always audible: a watchdog firing means nothing at all came back,
      // which the user cannot discover any other way.
      collapsePendingDownload(`no progress for ${effectiveMs}ms`, {
        alwaysNotify: true,
      });
    }
  }, effectiveMs);
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

/**
 * The updater cannot recover on its own, so stop waiting for it.
 *
 * Reached when a check is STILL being refused after a download was already
 * retired: Squirrel is parked on a download that will never finish, so no
 * later check can succeed and `pending` can never come back. Without this the
 * user is left with no button, no toast and no link at all.
 */
function escalateToManualDownload(reason: string): void {
  if (currentStatus.kind === "manual" || currentStatus.kind === "downloaded") {
    return;
  }
  log.error(`Auto-update cannot recover (${reason}); offering manual download`);
  clearStalledInstallWatchdog();
  setStatus({ kind: "manual" });
  broadcastUpdateError();
}

/**
 * Shared tail of the real and the simulated `error` handler.
 *
 * A `pending` is retired; anything else only needs a re-broadcast so a
 * renderer that missed the last status catches up. `manual` deliberately gets
 * no toast — the pill already points at the releases page, and the updater can
 * keep failing on every 10-minute poll for the life of the process.
 */
function retireAfterUpdaterError(
  reason: string,
  { alwaysNotify = false }: { alwaysNotify?: boolean } = {},
): void {
  if (currentStatus.kind === "pending") {
    collapsePendingDownload(reason, { alwaysNotify });
    return;
  }
  broadcast();
  if (alwaysNotify && currentStatus.kind !== "manual") {
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
    log.info("Checking for updates...");
  });

  autoUpdater.on("update-available", () => {
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
    if (currentStatus.kind === "pending") {
      // Already downloading. Re-announcing must not restart the stall
      // deadline: a poll every 10 minutes would push a 20-minute watchdog out
      // forever, and the button-that-does-nothing would be back.
      log.info("Update available, download already in progress");
      return;
    }
    log.info("Update available, downloading...");
    setStatus({ kind: "pending", installRequested: false });
    // Armed on ENTERING pending, not only when the user clicks: a download
    // that dies quietly used to leave the button up for the life of the
    // process with nothing behind it.
    startStalledInstallWatchdog(stalledDownloadTimeoutMs);
  });

  autoUpdater.on("update-not-available", () => {
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
    // Before anything else: a refused EXTRA check says nothing about the
    // download, so leave an in-flight one alone — status and watchdog stay.
    if (isRefusedConcurrentCheck(error)) {
      if (currentStatus.kind === "pending") {
        log.info(
          "Ignoring update check refused while a download is already in flight",
        );
        return;
      }
      if (currentStatus.kind === "idle" && collapsedDownloads > 0) {
        // Squirrel is still holding the download we already retired, so every
        // later check is refused too and `pending` never comes back. Nothing
        // else in this file can surface that, so hand over the manual link.
        escalateToManualDownload("checks still refused after a collapse");
        return;
      }
      log.info("Ignoring update check refused while the updater is busy");
      return;
    }
    log.error("Auto-updater error:", error);
    const wasQuittingForUpdate = isQuittingForUpdate;
    isQuittingForUpdate = false;

    // Always notify users in packaged builds — Bug 2: previously we only
    // broadcast when the user had clicked, so download failures before any
    // click silently swallowed the error and the button kept inviting clicks.
    retireAfterUpdaterError("updater error", {
      alwaysNotify: app.isPackaged || wasQuittingForUpdate,
    });
  });

  autoUpdater.on("update-downloaded", (_event, releaseNotes, releaseName) => {
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
      // Bring the deadline forward to the shorter someone-is-watching
      // timeout, but never past the download's own deadline (Bug 1).
      startStalledInstallWatchdog(stalledInstallTimeoutMs);
    } else {
      // `manual` lands here too. The renderer opens the releases page instead
      // of sending this, so a click that arrives anyway raced the status
      // change — and the collapse that set `manual` already broadcast the
      // error this branch would repeat.
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
      // Runs the real handler's tail so QA sees the shipped retirement path,
      // including the second collapse that flips the pill to the manual
      // download.
      retireAfterUpdaterError("simulated updater error");
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
