import { ipcMain, BrowserWindow, autoUpdater, app } from "electron";
import log from "electron-log";
import type {
  UpdateStatus,
  UpdateFailureReason,
} from "../../../shared/desktop-update.js";
import {
  attemptPath,
  installedVersionMatches,
  newAttempt,
  readAttempt,
  removeAttempt,
  saveAttempt,
  updateVersion,
  type UpdateAttempt,
} from "./update-attempt.js";
import { flushUpdateReports, reportUpdateFailure } from "./update-reporting.js";

export type { UpdateStatus } from "../../../shared/desktop-update.js";
export { RELAUNCH_MARKER_MAX_AGE_MS } from "./update-attempt.js";
export const DEFAULT_STALLED_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_STALLED_QUIT_TIMEOUT_MS = 30_000;
export const UPDATE_POLL_INTERVAL_MS = 10 * 60_000;

let currentStatus: UpdateStatus = { kind: "idle" };
let attempt: UpdateAttempt | undefined;
let trustedWindow: BrowserWindow | null = null;
let listenersRegistered = false;
let terminal = false;
let isQuittingForUpdate = false;
let installingOnQuit = false;
// Never reset this latch after an error. Electron registers a native observer
// before attempting the install; calling twice can crash even if the first threw.
let quitAndInstallCalled = false;
let downloadTimer: ReturnType<typeof setTimeout> | undefined;
let quitTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let downloadTimeoutMs = DEFAULT_STALLED_DOWNLOAD_TIMEOUT_MS;
let quitTimeoutMs = DEFAULT_STALLED_QUIT_TIMEOUT_MS;
let generation = 0;

function markerPath(): string {
  return attemptPath(app.getPath("userData"));
}
function clearDownloadTimer(): void {
  clearTimeout(downloadTimer);
  downloadTimer = undefined;
}
function clearQuitTimer(): void {
  clearTimeout(quitTimer);
  quitTimer = undefined;
}
function stopPolling(): void {
  clearInterval(pollTimer);
  pollTimer = undefined;
}
function ensureAttempt(): UpdateAttempt {
  return (attempt ??= newAttempt(app.getVersion()));
}
function persist(): boolean {
  return !app.isPackaged || (!!attempt && saveAttempt(markerPath(), attempt));
}
function report(reason: UpdateFailureReason): void {
  const a = ensureAttempt();
  if (app.isPackaged) reportUpdateFailure(a, reason);
}

function setStatus(status: UpdateStatus): void {
  currentStatus = status;
  // Only our trusted application window should receive update diagnostics.
  const win = trustedWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send("update-status", status);
  if (status.kind === "failed") win.webContents.send("update-error", status);
}

function finishFailure(reason: UpdateFailureReason): void {
  report(reason);
  clearDownloadTimer();
  clearQuitTimer();
  stopPolling();
  terminal = true;
  isQuittingForUpdate = false;
  installingOnQuit = false;
  const a = ensureAttempt();
  a.phase = "failed";
  a.failure = reason;
  // Even if storage failed, keep the in-memory failure visible and never loop.
  persist();
  setStatus({
    kind: "failed",
    attemptId: a.id,
    version: a.targetVersion,
    reason,
  });
}

function startDownloadTimer(): void {
  if (downloadTimer !== undefined) return;
  downloadTimer = setTimeout(() => {
    downloadTimer = undefined;
    handleFailure("download_timeout");
  }, downloadTimeoutMs);
}

function recover(): void {
  const a = ensureAttempt();
  clearDownloadTimer();
  clearQuitTimer();
  stopPolling();
  isQuittingForUpdate = false;
  installingOnQuit = false;
  a.retries = 1;
  a.phase = "recovering";
  a.at = Date.now();
  if (!persist()) {
    finishFailure("marker_write_failed");
    return;
  }
  setStatus({ kind: "recovering", attemptId: a.id, version: a.targetVersion });
  const currentGeneration = generation;
  // Report the failed attempt before leaving, with a hard upper bound even if
  // Sentry's own flush never settles. Never force-exit or skip browser cleanup.
  void flushUpdateReports().then(() => {
    if (
      generation !== currentGeneration ||
      terminal ||
      currentStatus.kind !== "recovering"
    )
      return;
    try {
      app.relaunch();
      quitTimer = setTimeout(
        () => finishFailure("shutdown_stuck"),
        quitTimeoutMs,
      );
      app.quit();
    } catch {
      finishFailure("restart_failed");
    }
  });
}

function handleFailure(reason: UpdateFailureReason): void {
  if (terminal || currentStatus.kind === "recovering") return;
  const a = ensureAttempt();
  const wasInstallingOnQuit = installingOnQuit;
  const failureReason =
    reason === "install_timeout" && (a.retries === 1 || wasInstallingOnQuit)
      ? "shutdown_stuck"
      : reason;
  report(failureReason);
  clearDownloadTimer();
  clearQuitTimer();
  isQuittingForUpdate = false;
  installingOnQuit = false;
  if (
    app.isPackaged &&
    a.userRequested &&
    a.retries === 0 &&
    !wasInstallingOnQuit
  ) {
    recover();
  } else {
    finishFailure(failureReason);
    if (wasInstallingOnQuit) {
      // Let the original before-quit handler unwind before finishing a quit
      // that had been prevented while waiting for the native installer.
      const currentGeneration = generation;
      setTimeout(() => {
        if (generation === currentGeneration) app.quit();
      }, 0);
    }
  }
}

function install(onQuit = false): void {
  if (
    !app.isPackaged ||
    terminal ||
    isQuittingForUpdate ||
    currentStatus.kind !== "downloaded"
  )
    return;
  const a = ensureAttempt();
  a.phase = "installing";
  a.at = Date.now();
  installingOnQuit = onQuit;
  if (!persist()) {
    handleFailure("marker_write_failed");
    return;
  }
  if (quitAndInstallCalled) {
    handleFailure("install_refused");
    return;
  }
  quitAndInstallCalled = true;
  isQuittingForUpdate = true;
  try {
    autoUpdater.quitAndInstall();
    // The call can synchronously emit an error. Do not re-arm a watchdog after
    // its error handler has already switched to recovery or failure.
    if (isQuittingForUpdate) {
      quitTimer = setTimeout(
        () => handleFailure("install_timeout"),
        quitTimeoutMs,
      );
    }
  } catch {
    handleFailure("install_threw");
  }
}

function restoreAttempt(): void {
  const loaded = readAttempt(markerPath());
  if (loaded.kind === "none") return;
  if (loaded.kind === "invalid") {
    // Never infer authorization to restart from an old or malformed marker.
    attempt = newAttempt(app.getVersion());
    attempt.retries = 1;
    finishFailure("marker_invalid");
    if (removeAttempt(markerPath())) {
      terminal = false;
      attempt = undefined;
    }
    return;
  }
  attempt = loaded.attempt;
  if (installedVersionMatches(attempt, app.getVersion())) {
    if (!removeAttempt(markerPath())) {
      finishFailure("marker_write_failed");
      return;
    }
    attempt = undefined;
    return;
  }
  if (attempt.phase === "failed") {
    setStatus({
      kind: "failed",
      attemptId: attempt.id,
      reason: attempt.failure!,
      version: attempt.targetVersion,
    });
    // A deliberate later launch can check again, but never auto-install from
    // this failed attempt. The stored error remains available via the snapshot.
    if (!removeAttempt(markerPath())) {
      terminal = true;
      return;
    }
    attempt = undefined;
    return;
  }
  if (loaded.kind === "expired") {
    // Expiry revokes unattended recovery, not verification: a successful
    // update is still successful when the user reopens the app next week.
    finishFailure("recovery_expired");
    if (removeAttempt(markerPath())) {
      terminal = false;
      attempt = undefined;
    }
    return;
  }
  if (attempt.phase === "installing") {
    handleFailure("version_unchanged");
    return;
  }
  if (attempt.userRequested && attempt.retries === 1) {
    attempt.phase = "downloading";
    attempt.at = Date.now();
    if (!persist()) {
      finishFailure("marker_write_failed");
      return;
    }
    setStatus({
      kind: "pending",
      installRequested: true,
      version: attempt.targetVersion,
    });
    startDownloadTimer();
    return;
  }
  // An interrupted first download does not authorize an unattended install.
  if (!removeAttempt(markerPath())) {
    finishFailure("marker_write_failed");
    return;
  }
  attempt = undefined;
}

function handleUpdaterError(reason: UpdateFailureReason): void {
  if (
    !isQuittingForUpdate &&
    !installingOnQuit &&
    (currentStatus.kind === "idle" || currentStatus.kind === "failed")
  ) {
    log.warn("Update check failed; will retry on the next poll");
    return;
  }
  handleFailure(reason);
}

export function setupAutoUpdaterEvents(): void {
  autoUpdater.on("checking-for-update", () =>
    log.info("Checking for updates..."),
  );
  autoUpdater.on("update-available", () => {
    if (
      terminal ||
      currentStatus.kind === "recovering" ||
      currentStatus.kind === "downloaded"
    )
      return;
    const a = ensureAttempt();
    setStatus({
      kind: "pending",
      installRequested: a.userRequested,
      version: a.targetVersion,
    });
    startDownloadTimer();
  });
  autoUpdater.on("update-not-available", () => {
    if (
      terminal ||
      currentStatus.kind === "recovering" ||
      currentStatus.kind === "downloaded"
    )
      return;
    clearDownloadTimer();
    if (currentStatus.kind === "pending") handleFailure("no_update");
    else setStatus({ kind: "idle" });
  });
  autoUpdater.on("error", (error: Error & { domain?: string }) => {
    // An overlapping native check is not evidence that the download failed.
    if (
      error.domain === "RACCommandErrorDomain" ||
      /AutoUpdater process .* is already running/i.test(error.message)
    )
      return;
    handleUpdaterError(
      error.message?.includes("No update available, can't quit and install")
        ? "install_refused"
        : "updater_error",
    );
  });
  autoUpdater.on("update-downloaded", (_event, releaseNotes, releaseName) => {
    if (terminal || currentStatus.kind === "recovering" || isQuittingForUpdate)
      return;
    clearDownloadTimer();
    stopPolling();
    const a = ensureAttempt();
    a.targetVersion = updateVersion(releaseName || "");
    setStatus({
      kind: "downloaded",
      version: releaseName || "new version",
      releaseNotes: releaseNotes || "",
    });
    if (a.userRequested) install();
  });
  if (app.isPackaged) restoreAttempt();
}

export function startUpdatePolling(): void {
  if (
    !app.isPackaged ||
    !["darwin", "win32"].includes(process.platform) ||
    pollTimer !== undefined ||
    terminal ||
    currentStatus.kind === "recovering" ||
    currentStatus.kind === "downloaded"
  )
    return;
  const version = app.getVersion();
  try {
    autoUpdater.setFeedURL({
      url: `https://update.electronjs.org/MCPJam/inspector/${process.platform}-${process.arch}/${version}`,
      headers: {
        "User-Agent": `mcpjam-inspector/${version} (${process.platform}: ${process.arch})`,
      },
      serverType: "default",
    });
    const check = () => {
      if (
        terminal ||
        currentStatus.kind === "downloaded" ||
        currentStatus.kind === "recovering"
      )
        return;
      try {
        autoUpdater.checkForUpdates();
      } catch {
        handleUpdaterError("updater_error");
      }
    };
    pollTimer = setInterval(() => {
      // A recovery may start in pending before its first check. Only the first
      // check should run then; never start another check during a download.
      if (currentStatus.kind !== "pending") check();
    }, UPDATE_POLL_INTERVAL_MS);
    check();
  } catch {
    handleFailure("updater_error");
  }
}

function isTrusted(senderId: number): boolean {
  return (
    !!trustedWindow &&
    !trustedWindow.isDestroyed() &&
    senderId === trustedWindow.webContents.id
  );
}

export function setTrustedUpdateWindow(window: BrowserWindow): void {
  trustedWindow = window;
  if (window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", () => {
      if (trustedWindow === window) setStatus(currentStatus);
    });
  } else setStatus(currentStatus);
}

export function registerUpdateListeners(window: BrowserWindow): void {
  setTrustedUpdateWindow(window);
  if (listenersRegistered) return;
  listenersRegistered = true;
  ipcMain.handle("app:get-update-status", (event) =>
    isTrusted(event.sender.id) ? currentStatus : { kind: "idle" },
  );
  ipcMain.on("app:restart-for-update", (event) => {
    if (!isTrusted(event.sender.id) || terminal || isQuittingForUpdate) return;
    if (currentStatus.kind !== "pending" && currentStatus.kind !== "downloaded")
      return;
    const a = ensureAttempt();
    a.userRequested = true;
    if (currentStatus.kind === "downloaded") install();
    else {
      // Clicking does not shorten the download's original twenty-minute budget.
      setStatus({ ...currentStatus, installRequested: true });
      if (!persist()) finishFailure("marker_write_failed");
    }
  });
  if (!app.isPackaged) {
    ipcMain.on("app:simulate-update", (event) => {
      if (!isTrusted(event.sender.id)) return;
      clearDownloadTimer();
      clearQuitTimer();
      terminal = false;
      attempt = newAttempt(app.getVersion());
      setStatus({ kind: "pending", installRequested: false });
      startDownloadTimer();
    });
    ipcMain.on("app:simulate-update-downloaded", (event) => {
      if (!isTrusted(event.sender.id)) return;
      clearDownloadTimer();
      terminal = false;
      setStatus({
        kind: "downloaded",
        version: "99.0.0",
        releaseNotes: "Simulated update",
      });
    });
    ipcMain.on("app:simulate-update-error", (event) => {
      if (isTrusted(event.sender.id)) finishFailure("updater_error");
    });
  }
}

export function installUpdateOnQuit(): boolean {
  if (
    !app.isPackaged ||
    terminal ||
    isQuittingForUpdate ||
    currentStatus.kind !== "downloaded"
  )
    return false;
  install(true);
  return isQuittingForUpdate;
}

export function __resetUpdateStateForTests(): void {
  generation++;
  clearDownloadTimer();
  clearQuitTimer();
  stopPolling();
  currentStatus = { kind: "idle" };
  attempt = undefined;
  trustedWindow = null;
  listenersRegistered = false;
  terminal = false;
  isQuittingForUpdate = false;
  installingOnQuit = false;
  quitAndInstallCalled = false;
  downloadTimeoutMs = DEFAULT_STALLED_DOWNLOAD_TIMEOUT_MS;
  quitTimeoutMs = DEFAULT_STALLED_QUIT_TIMEOUT_MS;
}
export function __setStalledDownloadTimeoutForTests(ms: number): void {
  downloadTimeoutMs = ms;
}
export function __setStalledQuitTimeoutForTests(ms: number): void {
  quitTimeoutMs = ms;
}
