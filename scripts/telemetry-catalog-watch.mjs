/**
 * `generate-telemetry-catalogs.mjs --watch`: keep the catalogs current while a
 * dev loop runs. One watcher per checkout; every dev entry point may start
 * one, and the second logs "already watching" and exits 0.
 *
 * Events are debounced, so a branch switch becomes one rescan. A rescan
 * re-walks the tree (about 20 ms) and re-parses only files whose mtime or
 * size changed, so additions, deletions and renames all land.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SKIP_DIRS, SOURCE, cacheDir, loadCatalogCache, writeTelemetryCatalogs } from "./generate-telemetry-catalogs.mjs";
import { loadTypeScript } from "./telemetry-route-catalog.mjs";

const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 10_000;
// A lock whose owner stopped refreshing it (killed, or a reused PID) is stale.
const STALE_MS = 3 * HEARTBEAT_MS;
const TREES = ["sdk/src", "mcpjam-inspector"];

function ownerAlive(lock) {
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    if (Date.now() - statSync(lock).mtimeMs > STALE_MS) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Take the checkout's watcher lock, or report that a live watcher holds it. */
export function acquireWatchLock(root = ROOT) {
  const lock = join(cacheDir(root), "watch.lock");
  mkdirSync(cacheDir(root), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      const release = () => {
        try {
          if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock);
        } catch {
          // Already gone: nothing to release.
        }
      };
      const heartbeat = setInterval(() => {
        try {
          utimesSync(lock, new Date(), new Date());
        } catch {
          // Removed under us: a later watcher takes over once it looks stale.
        }
      }, HEARTBEAT_MS);
      heartbeat.unref();
      process.once("exit", release);
      return { lock, release };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (ownerAlive(lock)) return null;
    rmSync(lock, { force: true });
  }
  return null;
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

export function watchTelemetryCatalogs({ root = ROOT, log = console.log } = {}) {
  const lock = acquireWatchLock(root);
  if (!lock) {
    log("[telemetry] already watching this checkout's catalogs");
    return null;
  }
  const cache = loadCatalogCache(root);
  let timer;
  let poller;
  let resync = false;
  let sources = { sync() {}, close() {} };
  // Out of inotify watches, for example: poll instead of going stale.
  const poll = (error) => {
    sources.close();
    sources = { sync() {}, close() {} };
    log(`[telemetry] file watching unavailable (${error.code ?? error.message}); polling every second`);
    poller ??= setInterval(scan, 1000);
  };
  const scan = () => {
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
  scan();
  // Now rather than on the first save, so that edit lands within budget.
  loadTypeScript();
  try {
    sources = watchSources(root, schedule);
  } catch (error) {
    poll(error);
  }
  const stop = () => {
    clearTimeout(timer);
    clearInterval(poller);
    sources.close();
    lock.release();
  };
  const exit = () => {
    stop();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, exit);
  // Spawned with an IPC channel (Vite, electron:dev): leave with the parent,
  // even when a signal kills it before it can stop this process.
  if (process.connected) process.once("disconnect", exit);
  log("[telemetry] watching sources; catalogs update on save");
  return { stop, scan };
}
