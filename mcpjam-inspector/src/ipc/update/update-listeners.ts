import { ipcMain, BrowserWindow, autoUpdater, app } from "electron";
import log from "electron-log";
import fs from "fs";
import path from "path";

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
// INSTALL: the user clicked and is watching a spinner. Thirty seconds, not
// minutes — anything a person waits through with no progress and no answer
// IS the reported bug, whatever the clock says. It costs a slow download
// nothing to be retired here: `update-downloaded` always wins, so a build
// that lands late still flips the pill back to a working Restart.
export const DEFAULT_STALLED_INSTALL_TIMEOUT_MS = 30_000;
// DOWNLOAD: nobody clicked, so we can wait longer — but not forever. Before
// this existed a download that started and never landed left the Update
// button on screen for the life of the process with nothing behind it.
export const DEFAULT_STALLED_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
// QUIT: the staged build is real and `quitAndInstall()` returned without
// throwing, so the app should be on its way out. If this timer ever fires the
// process is still alive, which means Squirrel took the install and did
// nothing with it — silently, since a throw or an `error` event would have
// been handled elsewhere. The renderer is sitting on "Updating…" with no
// status left to clear it, so this is the ONLY thing standing between that
// user and a spinner that runs for the life of the process.
export const DEFAULT_STALLED_QUIT_TIMEOUT_MS = 30_000;
// Same cadence update-electron-app used, so nothing about how quickly a user
// hears about a release changes — only that we can now STOP.
export const UPDATE_POLL_INTERVAL_MS = 10 * 60_000;
// How long a "relaunch and finish this install" marker stays good for. Long
// enough to survive a slow boot, short enough that a laptop opened next week
// does not silently install on launch.
export const RELAUNCH_MARKER_MAX_AGE_MS = 15 * 60_000;
// One restart to recover an install, never a second. If the fresh process
// cannot install either, the problem is not stale state and relaunching again
// would loop the app forever.
const MAX_INSTALL_RELAUNCH_ATTEMPTS = 1;
let stalledInstallTimeoutMs = DEFAULT_STALLED_INSTALL_TIMEOUT_MS;
let stalledDownloadTimeoutMs = DEFAULT_STALLED_DOWNLOAD_TIMEOUT_MS;
let stalledQuitTimeoutMs = DEFAULT_STALLED_QUIT_TIMEOUT_MS;

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

/**
 * Electron has forgotten the staged build, so `quitAndInstall()` is a no-op.
 *
 * `auto_updater_mac.mm` keeps ONE boolean, `g_update_available`, and clears it
 * on every check that ends without a new build — including the 10-minute poll
 * that runs right after a successful download and correctly answers "nothing
 * newer". `QuitAndInstall()` reads that boolean and, when it is false, emits
 * this exact string instead of doing anything. The staged app is still on
 * disk; only Electron's memory of it is gone.
 *
 * Nothing in the event stream distinguishes that from a real failure, so the
 * message is what we have. It is a literal in Electron's source, not a
 * localized or formatted string.
 */
const INSTALL_REFUSED_MESSAGE = "No update available, can't quit and install";

function isInstallRefusedByElectron(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { message } = error as { message?: unknown };
  return (
    typeof message === "string" && message.includes(INSTALL_REFUSED_MESSAGE)
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
// Armed only after a `quitAndInstall()` that returned without throwing.
let stalledQuitTimer: ReturnType<typeof setTimeout> | null = null;
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
// True only between `installUpdateOnQuit()` and its outcome. The user asked
// to QUIT, so a failure here must finish the quit, never relaunch.
let isInstallingOnQuit = false;
// Set on a launch that followed `relaunchToFinishInstall()`. The next
// download installs itself instead of waiting for a second click.
let installOnNextDownload = false;
// How many times we have already restarted the app to rescue this install.
let relaunchAttempts = 0;

function clearStalledInstallWatchdog(): void {
  if (stalledInstallTimer !== null) {
    clearTimeout(stalledInstallTimer);
    stalledInstallTimer = null;
  }
  stalledDownloadDeadline = null;
}

function clearStalledQuitWatchdog(): void {
  if (stalledQuitTimer !== null) {
    clearTimeout(stalledQuitTimer);
    stalledQuitTimer = null;
  }
}

/**
 * The last thing between the user and a spinner that never stops.
 *
 * `quitAndInstall()` is fire-and-forget: it hands the staged build to Squirrel
 * and, on success, the app is gone before this timer can fire. The failure
 * mode it covers is the silent one — Squirrel accepts the install, the process
 * keeps running, and NOTHING comes back. No throw (the call sites already
 * catch those), no `error` event, no status change. `isQuittingForUpdate`
 * stays true so every later click is ignored as "install already underway",
 * and the renderer keeps `restartRequested` because only `update-error`,
 * `idle` or `manual` clear it. That is the reported bug in its purest form:
 * "Updating…", forever, on a build that really was downloaded.
 *
 * So: unstick the flag and hand over the releases page, which is the one path
 * left that we know works.
 */
function startStalledQuitWatchdog(): void {
  clearStalledQuitWatchdog();
  const timeoutMs = stalledQuitTimeoutMs;
  stalledQuitTimer = setTimeout(() => {
    stalledQuitTimer = null;
    // Re-check at fire time: a real quit never gets here, and an `error` that
    // arrived first has already cleared the flag and answered the user.
    if (!isQuittingForUpdate) {
      return;
    }
    log.error(
      `Install never quit the app (no response for ${timeoutMs}ms); offering manual download`,
    );
    isQuittingForUpdate = false;
    // Deliberately not `escalateToManualDownload()` — that one refuses to
    // touch a `downloaded` status, which is exactly the status we are in.
    const version =
      currentStatus.kind === "downloaded" ? currentStatus.version : undefined;
    setStatus({ kind: "manual", version });
    broadcastUpdateError();
  }, timeoutMs);
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

function relaunchMarkerPath(): string {
  return path.join(app.getPath("userData"), ".install-update-on-relaunch");
}

/**
 * Remember, across a relaunch, that we are in the middle of an install.
 *
 * Deliberately a file and not memory: the whole point is that this process is
 * about to end. Best-effort — if it cannot be written the user simply gets
 * the normal "Update" button on the next launch instead of a hands-free
 * install, which is the pre-existing behaviour, not a new failure.
 */
function writeRelaunchMarker(attempts: number): boolean {
  try {
    fs.writeFileSync(
      relaunchMarkerPath(),
      JSON.stringify({ at: Date.now(), attempts }),
      "utf8",
    );
    return true;
  } catch (error) {
    log.error("Failed to write relaunch marker:", error);
    return false;
  }
}

/**
 * Consume the marker, if this launch is the one it was written for.
 *
 * Always deletes: a marker that is read once and left behind would re-arm a
 * hands-free install on every later launch.
 */
function consumeRelaunchMarker(): { attempts: number; resume: boolean } {
  // Two separate questions, and the cautious answer to each points the other
  // way. "How many relaunches have we spent?" must never UNDER-count, or the
  // budget resets and the app can relaunch forever. "Should we install
  // without asking?" must never OVER-trigger, or a file we could not actually
  // read starts an install nobody requested. So a marker we cannot make sense
  // of spends the budget without resuming anything.
  const spent = { attempts: 1, resume: false };
  const none = { attempts: 0, resume: false };

  const markerPath = relaunchMarkerPath();
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch (error) {
    // Nothing there is the normal case — every launch that did not follow a
    // relaunch lands here. Any OTHER failure means a marker may well exist
    // and we simply cannot see it.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return none;
    }
    log.error("Failed to read relaunch marker:", error);
    return spent;
  }
  try {
    fs.rmSync(markerPath, { force: true });
  } catch (error) {
    log.error("Failed to remove relaunch marker:", error);
  }
  let parsed: { at?: unknown; attempts?: unknown };
  try {
    parsed = JSON.parse(raw) as { at?: unknown; attempts?: unknown };
  } catch (error) {
    log.error("Relaunch marker is not readable JSON:", error);
    return spent;
  }
  const { at, attempts } = parsed;
  if (typeof at !== "number" || !Number.isFinite(at)) {
    return spent;
  }
  const age = Date.now() - at;
  // A negative age means the clock moved; treat it as untrustworthy rather
  // than as "very fresh".
  if (age < 0) {
    return spent;
  }
  // Genuinely old: a laptop opened next week must not install on launch, and
  // the budget is no longer about anything current.
  if (age > RELAUNCH_MARKER_MAX_AGE_MS) {
    return none;
  }
  return {
    attempts:
      Number.isInteger(attempts) && (attempts as number) > 0
        ? (attempts as number)
        : 1,
    resume: true,
  };
}

/**
 * Restart the app so Squirrel can download the build it lost.
 *
 * The one recovery path for a `downloaded` status Electron will not install.
 * A fresh process gets a fresh SQRLUpdater — new ETag memory, so the next
 * check really downloads instead of answering 304 "you already have it" — and
 * a `g_update_available` that is true at the moment we call `quitAndInstall`.
 *
 * Status goes to `idle` first so `installUpdateOnQuit()` does not try the very
 * install that just failed and block the quit we are asking for.
 */
function relaunchToFinishInstall(reason: string): void {
  clearStalledQuitWatchdog();
  isQuittingForUpdate = false;
  const version =
    currentStatus.kind === "downloaded" ? currentStatus.version : undefined;
  // Restarting the app is only a fix if it works. If we already relaunched
  // for this and are back here, restarting again would just do it forever —
  // an app that keeps disappearing on its own is worse than the dead button
  // this recovers from. Hand over the releases page, which always works.
  if (relaunchAttempts >= MAX_INSTALL_RELAUNCH_ATTEMPTS) {
    log.error(
      `Install still refused after ${relaunchAttempts} relaunch(es) (${reason}); offering manual download`,
    );
    setStatus({ kind: "manual", version });
    broadcastUpdateError();
    return;
  }
  // Relaunching without a marker on disk is the loop this bound exists to
  // stop: the fresh process would count zero attempts, try again, fail again
  // and restart again, with nothing ever accumulating. If the count cannot be
  // persisted, do not spend the restart at all.
  if (!writeRelaunchMarker(relaunchAttempts + 1)) {
    log.error(
      `Install refused by Electron (${reason}) and the retry could not be recorded; offering manual download`,
    );
    setStatus({ kind: "manual", version });
    broadcastUpdateError();
    return;
  }
  log.error(`Install refused by Electron (${reason}); relaunching to retry`);
  setStatus({ kind: "idle" });
  app.relaunch();
  app.quit();
}

/**
 * Poll for updates, and stop once there is a build staged.
 *
 * Replaces `update-electron-app`, which polls a blind `setInterval` forever.
 * That extra poll is the whole bug: it answers `update-not-available` (there
 * IS nothing newer than the build we just staged), Electron clears
 * `g_update_available`, and from that moment the Update button and the
 * install-on-quit path both fail with INSTALL_REFUSED_MESSAGE. It also drops
 * Squirrel out of its "awaiting relaunch" state, after which its own
 * housekeeping is free to delete the staged `update.*` directory while
 * ShipItState.plist still points at it.
 *
 * So the fix is to stop asking. A staged build is the end of this process's
 * update story; anything newer is the next launch's problem.
 */
export function startUpdatePolling(): void {
  if (!app.isPackaged) {
    log.info("Skipping update polling in development");
    return;
  }
  if (process.platform !== "darwin" && process.platform !== "win32") {
    log.info(`Auto-updates are not supported on ${process.platform}`);
    return;
  }
  if (updatePollTimer !== null) {
    return;
  }

  const version = app.getVersion();
  // Byte-for-byte the URL and User-Agent update-electron-app built, so the
  // update service sees the same request it always has.
  const feedURL = `https://update.electronjs.org/MCPJam/inspector/${process.platform}-${process.arch}/${version}`;
  const userAgent = `mcpjam-inspector/${version} (${process.platform}: ${process.arch})`;
  log.info(`feedURL ${feedURL}`);
  autoUpdater.setFeedURL({
    url: feedURL,
    headers: { "User-Agent": userAgent },
    serverType: "default",
  });

  const checkNow = () => {
    if (currentStatus.kind === "downloaded") {
      log.info("Update staged — skipping poll until restart");
      return;
    }
    autoUpdater.checkForUpdates();
  };

  checkNow();
  updatePollTimer = setInterval(checkNow, UPDATE_POLL_INTERVAL_MS);
}

function stopUpdatePolling(): void {
  if (updatePollTimer !== null) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
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
  // Did the previous process relaunch us mid-install? Read it once, here,
  // before any check can fire.
  if (app.isPackaged) {
    const marker = consumeRelaunchMarker();
    relaunchAttempts = marker.attempts;
    if (marker.resume) {
      log.info("Resuming an update install that needed a relaunch");
      installOnNextDownload = true;
    }
  }

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
    if (currentStatus.kind === "downloaded") {
      // A staged build outranks a fresh announcement. update-electron-app
      // never stops polling after a download, so without this a poll would
      // walk `downloaded` back to `pending` — and now that `pending` is no
      // longer sticky, the poll's own `update-not-available` would then
      // collapse it. The user would watch "Restart to update" disappear for
      // a build that is on disk and installs on next launch.
      log.info("Update available, but a build is already staged — keeping it");
      return;
    }
    log.info("Update available, downloading...");
    // After a relaunch-to-retry the user already clicked Update once, in the
    // previous process. Show them the spinner they expect rather than an
    // Update button asking for the same click again.
    setStatus({ kind: "pending", installRequested: installOnNextDownload });
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
    // Electron lost track of a build that is still staged. Not a download
    // failure and not something the user can fix by clicking again — the only
    // way back is a fresh process, so take it rather than leaving a button
    // that answers with this same error every time (BUG: 6 clicks, no effect,
    // then 3 refused quits, INSPECTOR desktop 3.8.0).
    if (isInstallRefusedByElectron(error) && currentStatus.kind !== "manual") {
      if (isInstallingOnQuit) {
        // `before-quit` called preventDefault() expecting the install to take
        // the app down, and it never will. Finish the quit the user asked
        // for. Status drops to `idle` first so the re-entered `before-quit`
        // does not start this same install again and block them a second
        // time — which is how a user ends up unable to quit at all.
        log.error("Install refused at quit — quitting without installing");
        isQuittingForUpdate = false;
        isInstallingOnQuit = false;
        clearStalledQuitWatchdog();
        setStatus({ kind: "idle" });
        app.quit();
        return;
      }
      relaunchToFinishInstall("staged build no longer known to Electron");
      return;
    }
    const wasQuittingForUpdate = isQuittingForUpdate;
    isQuittingForUpdate = false;
    isInstallingOnQuit = false;
    // A real error is an answer, and it reaches the user through the path
    // below — so the silent-quit watchdog has nothing left to catch.
    clearStalledQuitWatchdog();

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
    // The click that started this may have happened in the PREVIOUS process,
    // before the relaunch. Either way we install now, in the same tick as the
    // download, which is the one moment Electron is guaranteed to still know
    // about the staged build.
    const installRequested =
      installOnNextDownload ||
      (currentStatus.kind === "pending"
        ? currentStatus.installRequested
        : false);
    installOnNextDownload = false;
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
        // Returning is not succeeding — see startStalledQuitWatchdog.
        startStalledQuitWatchdog();
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
        // The click path the bug report came through: if this install goes
        // nowhere, nothing else will ever clear the spinner.
        startStalledQuitWatchdog();
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
      // Same success cleanup the real `update-downloaded` handler does, so a
      // simulated success does not leave the previous download's deadline or
      // collapse count behind for the next simulated run.
      clearStalledInstallWatchdog();
      collapsedDownloads = 0;
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
    isInstallingOnQuit = true;
    try {
      autoUpdater.quitAndInstall();
      return true;
    } catch (error) {
      isInstallingOnQuit = false;
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
  clearStalledQuitWatchdog();
  stopUpdatePolling();
  currentStatus = { kind: "idle" };
  isQuittingForUpdate = false;
  isInstallingOnQuit = false;
  installOnNextDownload = false;
  relaunchAttempts = 0;
  trustedWindow = null;
  updateListenersRegistered = false;
  collapsedDownloads = 0;
  stalledInstallTimeoutMs = DEFAULT_STALLED_INSTALL_TIMEOUT_MS;
  stalledDownloadTimeoutMs = DEFAULT_STALLED_DOWNLOAD_TIMEOUT_MS;
  stalledQuitTimeoutMs = DEFAULT_STALLED_QUIT_TIMEOUT_MS;
}

// Test-only timeout override so the watchdog test doesn't have to advance
// a full minute of fake timers.
export function __setStalledInstallTimeoutForTests(ms: number): void {
  stalledInstallTimeoutMs = ms;
}

export function __setStalledDownloadTimeoutForTests(ms: number): void {
  stalledDownloadTimeoutMs = ms;
}

export function __setStalledQuitTimeoutForTests(ms: number): void {
  stalledQuitTimeoutMs = ms;
}
