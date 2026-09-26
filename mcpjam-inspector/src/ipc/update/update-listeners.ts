import {
  ipcMain,
  BrowserWindow,
  autoUpdater,
  app,
  net,
  powerMonitor,
} from "electron";
import log from "electron-log";
import { UpdateClock } from "./update-clock.js";
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
let downloadClock: UpdateClock | undefined;
let nativeBusy = false;
let feedConfigured = false;
let suspended = false;
let powerListenersRegistered = false;
const DOWNLOAD_RETRY_DELAYS = [30_000, 120_000];
let quitTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let downloadTimeoutMs = DEFAULT_STALLED_DOWNLOAD_TIMEOUT_MS;
let quitTimeoutMs = DEFAULT_STALLED_QUIT_TIMEOUT_MS;
let generation = 0;

function markerPath(): string {
  return attemptPath(app.getPath("userData"));
}
function clearDownloadTimer(): void {
  downloadClock?.stop();
  downloadClock = undefined;
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

function finishFailure(
  reason: UpdateFailureReason,
  action: "retry-download" | "relaunch-retry" | "instructions" = "instructions",
): void {
  clearDownloadTimer();
  report(reason);
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
    action,
  });
}

function startBudget(
  ms: number,
  downloading: boolean,
  expired: () => void,
): void {
  clearDownloadTimer();
  downloadClock = new UpdateClock(
    () => !app.isPackaged || (app.isReady() && net.isOnline()),
    (active, sleep, offline) => {
      const a = ensureAttempt();
      if (downloading) a.activeDownloadMs += active;
      a.sleepMs += sleep;
      a.offlineMs += offline;
      if (
        downloading &&
        !nativeBusy &&
        currentStatus.kind === "pending" &&
        app.isPackaged
      ) {
        const g = generation;
        queueMicrotask(() => {
          if (g === generation && currentStatus.kind === "pending")
            checkForUpdate();
        });
      }
    },
  );
  if (suspended) downloadClock.suspend();
  downloadClock.start(ms, expired);
}

function startDownloadTimer(): void {
  if (downloadClock) return;
  startBudget(downloadTimeoutMs, true, () => {
    // A JS deadline cannot cancel Squirrel's native download. Only a confirmed
    // native error permits a new check in this process; otherwise relaunch.
    finishFailure("download_timeout", "relaunch-retry");
  });
}

function onSuspend(): void {
  suspended = true;
  downloadClock?.suspend();
}
function onResume(): void {
  suspended = false;
  downloadClock?.resume();
}

function configureFeed(): void {
  if (feedConfigured) return;
  const version = app.getVersion();
  autoUpdater.setFeedURL({
    url: `https://update.electronjs.org/MCPJam/inspector/${process.platform}-${process.arch}/${version}`,
    headers: {
      "User-Agent": `mcpjam-inspector/${version} (${process.platform}: ${process.arch})`,
    },
    serverType: "default",
  });
  feedConfigured = true;
}

function checkForUpdate(): void {
  if (
    !app.isReady() ||
    nativeBusy ||
    terminal ||
    suspended ||
    !net.isOnline() ||
    currentStatus.kind === "recovering" ||
    currentStatus.kind === "retry-waiting" ||
    currentStatus.kind === "downloaded"
  )
    return;
  try {
    configureFeed();
  } catch {
    finishFailure("updater_error");
    return;
  }
  nativeBusy = true;
  try {
    autoUpdater.checkForUpdates();
  } catch {
    handleUpdaterError("updater_error");
  }
}

function beginDownload(): void {
  clearDownloadTimer();
  const a = ensureAttempt();
  a.phase = "downloading";
  a.at = Date.now();
  delete a.failure;
  if (!persist()) {
    finishFailure("marker_write_failed");
    return;
  }
  setStatus({
    kind: "pending",
    version: a.targetVersion,
    installRequested: a.userRequested,
  });
  startDownloadTimer();
  if (app.isPackaged) checkForUpdate();
}

function retryDownloadFailure(): void {
  nativeBusy = false;
  clearDownloadTimer();
  const a = ensureAttempt();
  if (a.downloadRetries >= DOWNLOAD_RETRY_DELAYS.length) {
    finishFailure("updater_error", "retry-download");
    return;
  }
  const delay = DOWNLOAD_RETRY_DELAYS[a.downloadRetries++];
  a.phase = "retry_waiting";
  a.at = Date.now();
  log.warn("Update download failed; retry scheduled", {
    retry: a.downloadRetries,
  });
  if (!persist()) {
    finishFailure("marker_write_failed");
    return;
  }
  setStatus({
    kind: "retry-waiting",
    retry: a.downloadRetries,
    version: a.targetVersion,
  });
  startBudget(delay, false, beginDownload);
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
  clearDownloadTimer();
  report(failureReason);
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
    if (attempt.retries || attempt.downloadRetries || attempt.reported.length)
      reportUpdateFailure(attempt, "install_verified");
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
      action: ["updater_error", "download_timeout"].includes(attempt.failure!)
        ? "retry-download"
        : "instructions",
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
  if (attempt.phase === "retry_waiting") {
    setStatus({
      kind: "retry-waiting",
      retry: attempt.downloadRetries,
      version: attempt.targetVersion,
    });
    startBudget(
      DOWNLOAD_RETRY_DELAYS[attempt.downloadRetries - 1],
      false,
      beginDownload,
    );
    return;
  }
  if (attempt.phase === "downloading" && attempt.downloadRetries > 0) {
    // Preserve the spent retry budget across an interrupted download. This is
    // not permission to install unless it was already an install recovery.
    if (attempt.retries !== 1) attempt.userRequested = false;
    setStatus({
      kind: "pending",
      version: attempt.targetVersion,
      installRequested: attempt.userRequested,
    });
    startDownloadTimer();
    return;
  }
  if (attempt.phase === "installing") {
    handleFailure("version_unchanged");
    return;
  }
  if (
    (attempt.userRequested || attempt.downloadRecoveryRequested) &&
    attempt.retries === 1
  ) {
    attempt.phase = "downloading";
    attempt.at = Date.now();
    if (!persist()) {
      finishFailure("marker_write_failed");
      return;
    }
    setStatus({
      kind: "pending",
      installRequested: attempt.userRequested,
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
    isQuittingForUpdate ||
    installingOnQuit ||
    currentStatus.kind === "downloaded"
  ) {
    handleFailure(reason);
    return;
  }
  if (
    currentStatus.kind === "recovering" ||
    currentStatus.kind === "retry-waiting"
  )
    return;
  nativeBusy = false;
  if (
    terminal &&
    currentStatus.kind === "failed" &&
    currentStatus.reason === "download_timeout"
  ) {
    // A late native error releases the download engine, so a relaunch is no
    // longer needed. Keep the original report and expose the cheaper recovery.
    setStatus({ ...currentStatus, action: "retry-download" });
    return;
  }
  if (terminal) return;
  if (currentStatus.kind === "pending") retryDownloadFailure();
  else log.warn("Update check failed; will retry on the next poll");
}

export function setupAutoUpdaterEvents(): void {
  const currentGeneration = generation;
  void app.whenReady().then(() => {
    if (currentGeneration !== generation || powerListenersRegistered) return;
    powerListenersRegistered = true;
    powerMonitor.on("suspend", onSuspend);
    powerMonitor.on("resume", onResume);
  });
  autoUpdater.on("checking-for-update", () =>
    log.info("Checking for updates..."),
  );
  autoUpdater.on("update-available", () => {
    if (
      terminal ||
      currentStatus.kind === "recovering" ||
      currentStatus.kind === "retry-waiting" ||
      currentStatus.kind === "downloaded"
    )
      return;
    nativeBusy = true;
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
      currentStatus.kind === "retry-waiting" ||
      currentStatus.kind === "downloaded"
    )
      return;
    nativeBusy = false;
    clearDownloadTimer();
    if (attempt?.userRequested) handleFailure("no_update");
    else {
      if (!removeAttempt(markerPath())) {
        finishFailure("marker_write_failed");
        return;
      }
      attempt = undefined;
      setStatus({ kind: "idle" });
    }
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
    const lateDownload =
      currentStatus.kind === "failed" &&
      currentStatus.reason === "download_timeout" &&
      nativeBusy;
    if (
      (terminal && !lateDownload) ||
      currentStatus.kind === "recovering" ||
      isQuittingForUpdate
    )
      return;
    clearDownloadTimer();
    stopPolling();
    nativeBusy = false;
    terminal = false;
    const a = ensureAttempt();
    a.targetVersion = updateVersion(releaseName || "");
    if (lateDownload) a.userRequested = false;
    if (
      app.isPackaged &&
      (a.downloadRetries || a.downloadRequested || a.retries || lateDownload)
    )
      reportUpdateFailure(a, "download_recovered");
    delete a.failure;
    a.phase = "downloading";
    if (!persist()) {
      finishFailure("marker_write_failed");
      return;
    }
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
  pollTimer = setInterval(() => {
    if (currentStatus.kind !== "retry-waiting") checkForUpdate();
  }, UPDATE_POLL_INTERVAL_MS);
  checkForUpdate();
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
    if (
      !isTrusted(event.sender.id) ||
      terminal ||
      isQuittingForUpdate ||
      currentStatus.kind !== "downloaded"
    )
      return;
    ensureAttempt().userRequested = true;
    install();
  });
  ipcMain.on("app:retry-update-download", (event) => {
    if (
      !isTrusted(event.sender.id) ||
      currentStatus.kind !== "failed" ||
      currentStatus.action !== "retry-download" ||
      isQuittingForUpdate ||
      quitAndInstallCalled
    )
      return;
    attempt = newAttempt(app.getVersion());
    attempt.downloadRequested = true;
    terminal = false;
    beginDownload();
  });
  ipcMain.on("app:relaunch-update-download", (event) => {
    if (
      !isTrusted(event.sender.id) ||
      currentStatus.kind !== "failed" ||
      currentStatus.action !== "relaunch-retry" ||
      isQuittingForUpdate
    )
      return;
    if (!app.isPackaged) {
      setStatus({ kind: "recovering", attemptId: ensureAttempt().id });
      return;
    }
    attempt = newAttempt(app.getVersion());
    attempt.downloadRequested = true;
    attempt.downloadRecoveryRequested = true;
    terminal = false;
    recover();
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
      if (isTrusted(event.sender.id))
        finishFailure("updater_error", "retry-download");
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
  if (powerListenersRegistered) {
    powerMonitor.removeListener("suspend", onSuspend);
    powerMonitor.removeListener("resume", onResume);
  }
  powerListenersRegistered = false;
  suspended = false;
  nativeBusy = false;
  feedConfigured = false;
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
