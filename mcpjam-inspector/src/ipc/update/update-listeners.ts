import { ipcMain, BrowserWindow, autoUpdater, app } from "electron";
import log from "electron-log";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "pending"; version?: string; installRequested: boolean }
  | { kind: "downloaded"; version: string; releaseNotes?: string };

// Watchdog for a stuck `pending + installRequested` state. Squirrel.Mac can
// stall silently (mismatched TeamID, dropped connection) without firing
// `update-downloaded` or `error`. After this timeout we surface an error
// toast and unstick the UI — but we DON'T clear `isCheckingOrDownloading`,
// so if the download was just slow and `update-downloaded` arrives later,
// the user still sees the Update button reappear and can install. Five
// minutes is enough cover for a 100MB+ macOS update on a sluggish link;
// anything longer than that is much more likely a real stall than slow
// network. Exposed as a `let` so tests can shorten it via
// __setStalledInstallTimeoutForTests().
export const DEFAULT_STALLED_INSTALL_TIMEOUT_MS = 5 * 60_000;
let stalledInstallTimeoutMs = DEFAULT_STALLED_INSTALL_TIMEOUT_MS;

// Watchdog for an install that never starts. `quitAndInstall()` can return
// without quitting AND without throwing: Squirrel.Mac no-ops when it can't
// swap in the staged build (Team ID mismatch, unwritable staging dir). No
// event follows, so a process that is still alive is the only evidence.
//
// `window-all-closed` does not discriminate. On macOS `quitAndInstall()`
// closes every window first and only reaches Squirrel once the last one is
// gone, so the windows closing happens on the failing path exactly as it does
// on the working one, one step before the refusal.
//
// `before-quit` means something narrower than "the install worked": that
// Electron accepted a quit. On Windows `quitAndInstall()` calls `app.quit()`
// itself, synchronously, before it returns — so the event lands whether or not
// Update.exe took the request, and it lands BEFORE this timer can be armed
// unless we arm it first. On macOS it arrives only if Squirrel got as far as
// `[NSApp terminate:]`, which the silent refusal never does. Either way it is
// read when the watchdog fires, alongside the window list, rather than used to
// disarm on arrival: `main.ts` answers `before-quit` with `preventDefault()`
// and defers `app.quit()` behind an async browser teardown, so a quit that is
// genuinely underway can still be holding live windows at the deadline.
export const DEFAULT_INSTALL_QUIT_TIMEOUT_MS = 5_000;
let installQuitTimeoutMs = DEFAULT_INSTALL_QUIT_TIMEOUT_MS;

let currentStatus: UpdateStatus = { kind: "idle" };
let isQuittingForUpdate = false;
let isCheckingOrDownloading = false;
let trustedWindow: BrowserWindow | null = null;
let updateListenersRegistered = false;
let stalledInstallTimer: ReturnType<typeof setTimeout> | null = null;
let installQuitTimer: ReturnType<typeof setTimeout> | null = null;
// Set when the quit watchdog has already told the user this install attempt
// failed. Squirrel often follows its silent no-op with a late `error` of its
// own, and in a packaged build that handler notifies unconditionally — two
// toasts for one failure. Cleared when a new attempt or a new check begins,
// so a genuinely unrelated later error still reaches the user.
let installFailureReported = false;
// Set by `before-quit`: Electron accepted a quit. Cleared at the start of each
// install request, so when the watchdog reads it the answer is about this
// request's quit rather than some earlier one.
let quitSequenceStarted = false;
// Set when a failure was raised with no renderer to receive it. macOS keeps
// the app alive with every window closed, which is exactly the state a silent
// Squirrel refusal leaves behind, so the toast has to wait for the window the
// user reopens from the dock.
let pendingInstallFailure = false;

function clearStalledInstallWatchdog(): void {
  if (stalledInstallTimer !== null) {
    clearTimeout(stalledInstallTimer);
    stalledInstallTimer = null;
  }
}

function startStalledInstallWatchdog(): void {
  clearStalledInstallWatchdog();
  stalledInstallTimer = setTimeout(() => {
    stalledInstallTimer = null;
    // Re-check at fire-time: if anything succeeded or moved on, do nothing.
    if (currentStatus.kind === "pending" && currentStatus.installRequested) {
      log.error(
        `Auto-updater stalled in pending+installRequested for ${stalledInstallTimeoutMs}ms — surfacing error`,
      );
      // Clear BOTH `installRequested` (so the spinner unsticks) AND
      // `isCheckingOrDownloading` (so a follow-up Update click can call
      // `checkForUpdates()` again to re-trigger the download). Squirrel's
      // own `update-downloaded` event is independent of our flag, so if the
      // original download eventually completes anyway, the existing handler
      // still flips status to "downloaded" and the user can install.
      isCheckingOrDownloading = false;
      setStatus({ ...currentStatus, installRequested: false });
      broadcastUpdateError();
    }
  }, stalledInstallTimeoutMs);
}

function clearInstallQuitWatchdog(): void {
  if (installQuitTimer !== null) {
    clearTimeout(installQuitTimer);
    installQuitTimer = null;
  }
}

// Ask Squirrel to swap in the staged build and restart. A throw is surfaced
// immediately; a silent no-op is caught by the watchdog instead.
function requestQuitAndInstall(): void {
  // Clear first: a synchronous throw below returns early, and a watchdog left
  // armed from a previous call would then fire against a request that already
  // reported its failure.
  clearInstallQuitWatchdog();
  installFailureReported = false;
  pendingInstallFailure = false;
  quitSequenceStarted = false;
  // Armed before the call, not after: on Windows `quitAndInstall()` reaches
  // `app.quit()` synchronously, so `before-quit` has already come and gone by
  // the time it returns.
  installQuitTimer = setTimeout(() => {
    installQuitTimer = null;
    if (quitSequenceStarted) {
      // Electron took the quit; it is just not finished. `main.ts` holds
      // `before-quit` open for an async browser teardown, which outlives this
      // deadline on a loaded session. Saying "Update failed" here would be a
      // lie, and clearing `isQuittingForUpdate` would be worse: the deferred
      // `app.quit()` re-enters `before-quit`, and `installUpdateOnQuit()`
      // would then call `quitAndInstall()` a second time (INSPECTOR-ELECTRON-GT).
      log.warn(
        `quitAndInstall() started a quit that has not finished after ${installQuitTimeoutMs}ms — letting the shutdown run`,
      );
      return;
    }
    if (hasLiveWindow()) {
      // No quit began and the windows are still up: the call did nothing at
      // all. Tell the user, who is the one watching the pill — the toast
      // offers the manual download. Status stays "downloaded" because the
      // build really is staged; it's the swap-in that didn't happen, so
      // clearing the flag here lets the next click retry.
      log.error(
        `quitAndInstall() returned without starting a quit within ${installQuitTimeoutMs}ms — treating the install as failed`,
      );
      isQuittingForUpdate = false;
      // Only claim the failure is reported once a renderer has actually heard
      // it; otherwise the late Squirrel `error` would be deduped away against
      // a toast nobody saw.
      installFailureReported = true;
      broadcastUpdateError();
      return;
    }
    // No window left to tell. Squirrel may have refused after Electron closed
    // them — the same silent failure, just invisible until the user reopens
    // from the dock — or a working install may still be shutting down. We
    // can't tell the two apart, so don't cry wolf at error level, but leave a
    // line above `info`: a session that logs this and then keeps running is
    // the fingerprint of the bug this watchdog exists for. `isQuittingForUpdate`
    // stays set for the same reason as above — a shutdown we can't see the end
    // of must not be handed a second `quitAndInstall()`.
    log.warn(
      `quitAndInstall() has not quit after ${installQuitTimeoutMs}ms and no window remains — install may have been refused silently`,
    );
    // Hold the failure for whichever window comes next. A working install
    // never gets there — the process is gone — so this only surfaces on the
    // path where the user really does come back to a dead Update pill.
    pendingInstallFailure = true;
  }, installQuitTimeoutMs);
  try {
    autoUpdater.quitAndInstall();
  } catch (error) {
    // quitAndInstall can throw on macOS when the staged build is mis-signed
    // or Squirrel's staging dir is corrupted. Don't leave the quitting flag
    // stuck — surface the error so the user can retry.
    clearInstallQuitWatchdog();
    log.error("quitAndInstall threw:", error);
    isQuittingForUpdate = false;
    broadcastUpdateError();
  }
}

function hasLiveWindow(): boolean {
  return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed());
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

  const replayInstallFailure = pendingInstallFailure;
  if (replayInstallFailure) {
    pendingInstallFailure = false;
    // This window is the one that hears it, so the late Squirrel `error` can
    // now be deduped against a toast the user will actually see.
    installFailureReported = true;
  }

  if (currentStatus.kind === "idle" && !replayInstallFailure) {
    return;
  }

  const deliver = () => {
    if (window.isDestroyed()) {
      return;
    }
    if (currentStatus.kind !== "idle") {
      window.webContents.send("update-status", currentStatus);
    }
    if (replayInstallFailure) {
      window.webContents.send("update-error");
    }
  };

  if (window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", deliver);
    return;
  }

  deliver();
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("update-status", currentStatus);
    }
  }
}

// Fire-and-forget: an error with no window to receive it is dropped here on
// purpose. Only the install watchdog knows its failure is worth replaying to
// the window the user reopens; a download failure or a dead check has no such
// claim, and holding those would replay a stale toast and arm the `error`
// handler's dedupe against a Squirrel failure the user never heard about.
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
  // Record that a quit began; the watchdog decides what that is worth when it
  // fires. Deliberately NOT disarming here: on Windows this arrives inside the
  // `quitAndInstall()` call itself, so an all-clear-on-arrival would be spent
  // before the timer exists, and it arrives there on the refusing path too.
  app.on("before-quit", () => {
    quitSequenceStarted = true;
  });

  autoUpdater.on("checking-for-update", () => {
    isCheckingOrDownloading = true;
    // A fresh check starts a new cycle: whatever Squirrel reports from here
    // on is its own failure, not an echo of the install we already reported.
    installFailureReported = false;
    pendingInstallFailure = false;
    log.info("Checking for updates...");
  });

  autoUpdater.on("update-available", () => {
    isCheckingOrDownloading = true;
    log.info("Update available, downloading...");
    const installRequested =
      currentStatus.kind === "pending" ? currentStatus.installRequested : false;
    setStatus({ kind: "pending", installRequested });
  });

  autoUpdater.on("update-not-available", () => {
    isCheckingOrDownloading = false;
    log.info("No updates available");
    if (currentStatus.kind === "idle") {
      setStatus({ kind: "idle" });
      return;
    }
    // "No updates available" is the routine answer to a background poll, and
    // stays quiet. With an install requested it means something else: the user
    // clicked Update, is watching the spinner, and the build we promised is
    // never arriving. This branch used to clear the request and say nothing —
    // the pill spun, reverted to a live "Update", and invited the next click,
    // which re-checked and landed here again. That loop is what the reported
    // session looks like: 17 clicks, no restart, no toast, nothing above
    // `info` in the log. Report it like every other dead end in this file.
    if (currentStatus.kind === "pending" && currentStatus.installRequested) {
      clearStalledInstallWatchdog();
      log.error(
        "Auto-updater reported no update available while an install was requested — the staged build never arrived",
      );
      // Status stays "pending" so the button remains visible: Squirrel may
      // still deliver later, and `isCheckingOrDownloading` was cleared above,
      // so the next click gets a fresh check rather than a dead one.
      setStatus({ ...currentStatus, installRequested: false });
      broadcastUpdateError();
      return;
    }
    log.info(
      `Keeping visible update status after update-not-available: ${currentStatus.kind}`,
    );
  });

  autoUpdater.on("error", (error) => {
    isCheckingOrDownloading = false;
    clearStalledInstallWatchdog();
    // Squirrel reported the failure itself — don't let the watchdog fire a
    // second toast for the same install.
    clearInstallQuitWatchdog();
    log.error("Auto-updater error:", error);
    // Always notify users in packaged builds — Bug 2: previously we only
    // broadcast when the user had clicked, so download failures before any
    // click silently swallowed the error and the button kept inviting clicks.
    // A late error arriving after the quit watchdog already reported is
    // Squirrel explaining the failure we surfaced seconds ago. Log it, but
    // don't toast the same dead install twice.
    const alreadyReported = installFailureReported;
    installFailureReported = false;
    const shouldNotifyUser =
      !alreadyReported &&
      (app.isPackaged ||
        (currentStatus.kind === "pending" && currentStatus.installRequested) ||
        isQuittingForUpdate);

    if (currentStatus.kind === "pending") {
      setStatus({ ...currentStatus, installRequested: false });
    } else if (currentStatus.kind === "downloaded") {
      setStatus(currentStatus);
    } else {
      setStatus({ kind: "idle" });
    }
    isQuittingForUpdate = false;

    if (shouldNotifyUser) {
      broadcastUpdateError();
    }
  });

  autoUpdater.on("update-downloaded", (_event, releaseNotes, releaseName) => {
    isCheckingOrDownloading = false;
    clearStalledInstallWatchdog();
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
      requestQuitAndInstall();
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
      log.info("Restarting app to install update...");
      isQuittingForUpdate = true;
      requestQuitAndInstall();
    } else if (currentStatus.kind === "pending") {
      log.info("Update still downloading — queuing install for completion");
      setStatus({ ...currentStatus, installRequested: true });
      // Arm the watchdog — if neither `update-downloaded` nor `error` fires
      // within stalledInstallTimeoutMs, treat as stalled (Bug 1).
      startStalledInstallWatchdog();
      if (!isCheckingOrDownloading) {
        try {
          isCheckingOrDownloading = true;
          autoUpdater.checkForUpdates();
        } catch (error) {
          isCheckingOrDownloading = false;
          clearStalledInstallWatchdog();
          log.error("Failed to retry update check:", error);
          setStatus({ ...currentStatus, installRequested: false });
          broadcastUpdateError();
        }
      }
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
      // Dev simulation keeps its tighter notify rule (only the user-driven
      // case) so manual QA can still distinguish click-vs-no-click flows.
      const shouldNotifyUser =
        currentStatus.kind === "pending" && currentStatus.installRequested;
      if (currentStatus.kind === "pending") {
        setStatus({ ...currentStatus, installRequested: false });
      } else if (currentStatus.kind === "downloaded") {
        setStatus(currentStatus);
      } else {
        setStatus({ kind: "idle" });
      }
      if (shouldNotifyUser) {
        broadcastUpdateError();
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
    // Deliberately not requestQuitAndInstall(): arming the quit watchdog from
    // inside a `before-quit` emit only works if our own `before-quit` listener
    // happens to run before this one, and that ordering isn't something this
    // module controls. The failure is mild here anyway — a no-op leaves the
    // app running and the user's next quit closes it normally.
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
  clearInstallQuitWatchdog();
  currentStatus = { kind: "idle" };
  isQuittingForUpdate = false;
  isCheckingOrDownloading = false;
  installFailureReported = false;
  pendingInstallFailure = false;
  quitSequenceStarted = false;
  trustedWindow = null;
  updateListenersRegistered = false;
  stalledInstallTimeoutMs = DEFAULT_STALLED_INSTALL_TIMEOUT_MS;
  installQuitTimeoutMs = DEFAULT_INSTALL_QUIT_TIMEOUT_MS;
}

// Test-only timeout override so the watchdog test doesn't have to advance
// a full minute of fake timers.
export function __setStalledInstallTimeoutForTests(ms: number): void {
  stalledInstallTimeoutMs = ms;
}

export function __setInstallQuitTimeoutForTests(ms: number): void {
  installQuitTimeoutMs = ms;
}
