/**
 * `generate-telemetry-catalogs.mjs --watch`: keep the catalogs current while a
 * dev loop runs. One watcher per checkout writes; every dev entry point may
 * start one, and the others stand by and take over when the writer stops.
 *
 * Events are debounced, so a branch switch becomes one rescan. A rescan
 * re-walks the tree (about 20 ms) and re-parses only files whose mtime or
 * size changed, so additions, deletions and renames all land.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, SKIP_DIRS, SOURCE, checkoutCacheFile, loadCatalogCache, writeTelemetryCatalogs } from "./generate-telemetry-catalogs.mjs";
import { loadTypeScript } from "./telemetry-route-catalog.mjs";

const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 10_000;
// A lock whose owner stopped refreshing it (killed, or a reused PID) is stale.
const STALE_MS = 3 * HEARTBEAT_MS;
// How often a standby watcher checks whether the lock is free or stale.
const TAKEOVER_MS = 3_000;
const TREES = ["sdk/src", "mcpjam-inspector"];

function ownerAlive(lock) {
  try {
    if (Date.now() - statSync(lock).mtimeMs > STALE_MS) return false;
    const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
    // Empty: its owner has created it and not yet written to it.
    if (!(pid > 0)) return true;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Take the checkout's watcher lock, or return null while a live watcher holds
 * it. The lock holds a token, not only a PID, so a holder can tell that it was
 * judged stale (a long sleep, say) and another watcher now writes.
 */
export function acquireWatchLock(root = ROOT) {
  const lock = checkoutCacheFile(root, "watch", "lock");
  const token = `${process.pid} ${randomBytes(6).toString("hex")}`;
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, token, { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (attempt || ownerAlive(lock)) return null;
    rmSync(lock, { force: true });
  }
  const held = () => {
    try {
      return readFileSync(lock, "utf8") === token;
    } catch {
      return false;
    }
  };
  const release = () => {
    process.off("exit", release);
    if (held()) rmSync(lock, { force: true });
  };
  process.once("exit", release);
  return {
    lock,
    held,
    /** Keep a held lock fresh for standbys; false once it is someone else's. */
    refresh() {
      if (!held()) return false;
      try {
        utimesSync(lock, new Date(), new Date());
        return true;
      } catch {
        return false;
      }
    },
    release,
  };
}

/**
 * Directory watchers. macOS and Windows watch a tree natively; on Linux a
 * recursive watch would also descend into node_modules, so each source
 * directory gets its own watcher and the set is re-synced after renames.
 */
function watchSources(root, onEvent) {
  const relevant = (name) => !name || SOURCE.test(name) || !/\.[^/\\]+$/.test(name);
  const skipped = (name) => String(name).split(/[\\/]/).some((part) => SKIP_DIRS.has(part));
  const watchers = new Map();
  const open = (dir, options, filter) => {
    if (watchers.has(dir)) return;
    try {
      const watcher = watch(join(root, dir), options, (type, name) => {
        if (filter(name) && relevant(name)) onEvent(type === "rename");
      });
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(dir);
        onEvent(true);
      });
      watchers.set(dir, watcher);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
  const native = process.platform === "darwin" || process.platform === "win32";
  const sync = () => {
    open("sdk", {}, (name) => name === "tsup.config.ts");
    if (native) {
      for (const dir of TREES) open(dir, { recursive: true }, (name) => !skipped(name));
      return;
    }
    const live = new Set(["sdk"]);
    const visit = (dir) => {
      let entries;
      try {
        entries = readdirSync(join(root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      live.add(dir);
      open(dir, {}, () => true);
      for (const entry of entries) {
        const child = `${dir}/${entry.name}`;
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !existsSync(join(root, child, ".git"))) visit(child);
      }
    };
    for (const dir of TREES) visit(dir);
    for (const [dir, watcher] of watchers) if (!live.has(dir)) {
      watcher.close();
      watchers.delete(dir);
    }
  };
  const close = () => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
  try {
    sync();
  } catch (error) {
    close();
    throw error;
  }
  return { sync, close };
}

/**
 * Watch and rescan while `lock` is ours; `onLost` runs if another watcher
 * takes it. Null when it was lost before watching began.
 */
function watchWhileHeld({ root, log, cache, lock, onLost }) {
  let timer;
  let poller;
  let heartbeat;
  let stopped = false;
  let resync = false;
  let sources = { sync() {}, close() {} };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(poller);
    clearInterval(heartbeat);
    sources.close();
    lock.release();
  };
  // Judged stale and replaced: one writer per checkout, so hand over the writes.
  const lost = () => {
    stop();
    onLost("[telemetry] another watcher took over this checkout's catalogs; standing by");
  };
  // Out of inotify watches, for example: poll instead of going stale.
  const poll = (error) => {
    sources.close();
    sources = { sync() {}, close() {} };
    log(`[telemetry] file watching unavailable (${error.code ?? error.message}); polling every second`);
    poller ??= setInterval(scan, 1000);
  };
  const scan = () => {
    if (stopped) return;
    if (!lock.held()) return lost();
    const started = performance.now();
    if (resync) {
      resync = false;
      try {
        sources.sync();
      } catch (error) {
        poll(error);
      }
    }
    try {
      const written = writeTelemetryCatalogs({ root, cache });
      if (written.length) log(`[telemetry] updated ${written.join(", ")} in ${Math.round(performance.now() - started)} ms`);
    } catch (error) {
      // A file deleted between the walk and its parse: the next pass sees the settled tree.
      log(`[telemetry] catalog scan failed, retrying: ${error.message}`);
      resync = true;
      clearTimeout(timer);
      timer = setTimeout(scan, 1000);
    }
  };
  const schedule = (rename) => {
    resync ||= rename;
    clearTimeout(timer);
    timer = setTimeout(scan, DEBOUNCE_MS);
  };
  heartbeat = setInterval(() => {
    if (!lock.refresh()) lost();
  }, HEARTBEAT_MS);
  heartbeat.unref();
  scan();
  if (stopped) return null;
  // Now rather than on the first save, so that edit lands within budget.
  loadTypeScript();
  try {
    sources = watchSources(root, schedule);
  } catch (error) {
    poll(error);
  }
  log("[telemetry] watching sources; catalogs update on save");
  return { stop, scan };
}

/**
 * Keep this checkout's catalogs current. Only the lock holder writes; any
 * other watcher stands by, checking every `takeoverMs`, and takes over when
 * the lock is released or goes stale.
 */
export function watchTelemetryCatalogs({ root = ROOT, log = console.log, cache, takeoverMs = TAKEOVER_MS } = {}) {
  let session;
  let standby;
  const takeOver = () => {
    const lock = acquireWatchLock(root);
    if (!lock) return;
    clearInterval(standby);
    standby = undefined;
    // Loaded now: a standby that takes over later starts from the writer's saved facts.
    session = watchWhileHeld({ root, log, cache: cache ?? loadCatalogCache(root), lock, onLost: standBy }) ?? undefined;
  };
  const standBy = (message) => {
    session = undefined;
    log(message);
    standby ??= setInterval(() => {
      try {
        takeOver();
      } catch {
        // A lock mid-release (Windows will not open a file being deleted): retry on the next check.
      }
    }, takeoverMs);
  };
  takeOver();
  if (!session && !standby) standBy("[telemetry] another watcher keeps this checkout's catalogs current; standing by to take over");
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const stop = () => {
    clearInterval(standby);
    standby = undefined;
    session?.stop();
    session = undefined;
    for (const signal of signals) process.off(signal, exit);
    process.off("disconnect", exit);
  };
  const exit = () => {
    stop();
    process.exit(0);
  };
  for (const signal of signals) process.once(signal, exit);
  // Spawned with an IPC channel (Vite, electron:dev): leave with the parent,
  // even when a signal kills it before it can stop this process.
  if (process.connected) process.once("disconnect", exit);
  return {
    stop,
    scan: () => session?.scan(),
    /** Whether this watcher holds the lock and writes, rather than standing by. */
    get watching() {
      return Boolean(session);
    },
  };
}
