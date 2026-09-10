import type { Plugin } from "vite";

/**
 * Main-process hot restart for `electron-forge start`.
 *
 * Forge's vite plugin has the hook for this and leaves it empty. In
 * `@electron-forge/plugin-vite/dist/config/vite.base.config.js`, its
 * `pluginHotRestart('restart')` branch is a single commented-out line:
 *
 *     // TODO: blocked in #3380
 *     // process.stdin.emit('data', 'rs');
 *
 * So saving a main-process or preload file rebuilt the bundle and changed
 * nothing on screen -- the running Electron kept executing the previous one.
 * The fix is the line they commented out.
 *
 * WHY THAT LINE IS SAFE HERE. `electron-forge start`'s CLI hardcodes
 * `interactive: true`, and with it `@electron-forge/core`'s `start()` registers
 * `process.stdin.on('data', ...)` unconditionally, looking for `rs` -- the
 * manual restart people type by hand. These Vite builds run in the SAME process
 * as that listener, so emitting the event is a synchronous EventEmitter call.
 * No TTY, no pipe, no child process, and `stdin` being paused does not matter
 * because `emit` invokes listeners directly rather than reading the stream.
 * Forge's own `#3380` is about their starter template, not a technical blocker.
 *
 * IF FORGE EVER LANDS #3380, DELETE THIS FILE. Its `pluginHotRestart` will then
 * do exactly this, and the wiring in `vite.main.config.ts`,
 * `vite.preload.config.ts` and `forge.config.ts`'s `postStart` hook can go with
 * it. Nothing else imports it.
 *
 * Escape hatch: `MCPJAM_ELECTRON_DEV_NO_RESTART=1` -- for holding a breakpoint
 * in the main process, which a restart would drop.
 */

/** ~One debounce window. Long enough to coalesce, short enough to feel instant. */
const DEBOUNCE_MS = 250;

/**
 * How long a restart may take before we say something. Forge kills with
 * SIGTERM and respawns; a main process wedged in a teardown handler (we have
 * eight of them, over live PTYs, sockets and Chromium contexts) is the realistic
 * way this stalls, and in silence it reads as "my change didn't apply".
 */
const WATCHDOG_MS = 10_000;

type RestartScheduler = {
  timer: ReturnType<typeof setTimeout> | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  /** A restart has been asked of forge and `postStart` has not come back yet. */
  inFlight: boolean;
  /** A rebuild landed while a restart was in flight. */
  queued: boolean;
  /** Which builds asked for this restart, for the log line. */
  requestedBy: Set<string>;
  restarts: number;
};

/**
 * The scheduler has to live on `globalThis`, not in this module's scope.
 *
 * Vite esbuild-bundles each config file it loads separately, so
 * `vite.main.config.ts`, `vite.preload.config.ts` and `forge.config.ts` each get
 * their OWN copy of this module inside the one forge process -- three
 * independent sets of module-level variables. Debouncing and
 * serializing across them only works through state they genuinely share.
 */
const SCHEDULER_KEY = Symbol.for("mcpjam.forge.hotRestart");

function scheduler(): RestartScheduler {
  const host = globalThis as typeof globalThis & {
    [SCHEDULER_KEY]?: RestartScheduler;
  };
  host[SCHEDULER_KEY] ??= {
    timer: null,
    watchdog: null,
    inFlight: false,
    queued: false,
    requestedBy: new Set(),
    restarts: 0,
  };
  return host[SCHEDULER_KEY];
}

function restartDisabled(): boolean {
  return process.env.MCPJAM_ELECTRON_DEV_NO_RESTART === "1";
}

/**
 * `process.stderr.write`, not `console.*`: forge builds these targets inside a
 * Listr task renderer with `logLevel: 'silent'`, and `AGENTS.md` bans bare
 * `console.*` anyway.
 */
function log(message: string): void {
  process.stderr.write(`[hot-restart] ${message}\n`);
}

function fire(): void {
  const state = scheduler();
  state.timer = null;

  // Serialize. Forge's `rs` handler stacks a fresh `'exit'` listener on the
  // current child every time it runs, so two overlapping restarts leave a
  // listener that respawns a process nobody is tracking.
  if (state.inFlight) {
    state.queued = true;
    return;
  }

  const reason = [...state.requestedBy].sort().join(" + ") || "rebuild";
  state.requestedBy.clear();
  state.inFlight = true;
  state.restarts += 1;

  // Emit BEFORE logging. Forge's handler opens with
  // `readline.moveCursor(stdout, 0, -1)` + `clearLine` to overwrite the line
  // above with "Restarting Electron app" -- anything we print first gets erased.
  process.stdin.emit("data", "rs");
  log(`restart #${state.restarts} (${reason})`);

  state.watchdog = setTimeout(() => {
    state.watchdog = null;
    if (!state.inFlight) return;
    // Release the lock: a wedged restart must not disable every later one.
    state.inFlight = false;
    log(
      `!! restart #${state.restarts} did not complete within ${WATCHDOG_MS / 1000}s. ` +
        `The main process is probably stuck shutting down. Press Ctrl-C and ` +
        `re-run 'npm run electron:dev', or type 'rs' to retry.`,
    );
  }, WATCHDOG_MS);
}

function requestRestart(label: string): void {
  if (restartDisabled()) return;
  const state = scheduler();
  state.requestedBy.add(label);
  // A `shared/` edit invalidates the main and preload graphs at once, and forge
  // runs those two builds concurrently, so their `writeBundle`s land
  // milliseconds apart. Coalesce them into one restart.
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(fire, DEBOUNCE_MS);
}

/**
 * Called from `forge.config.ts`'s `postStart` hook, which forge runs after every
 * spawn -- including each respawn triggered by `rs`. That makes it the
 * restart-completed signal, and the only honest one available: the `rs` emit
 * itself returns before the child has died, let alone come back.
 *
 * Also runs once for the very first spawn, when nothing is in flight. Clearing
 * idle state is a no-op, so that needs no special case.
 */
export function notifyRestartComplete(): void {
  const state = scheduler();
  if (state.watchdog) {
    clearTimeout(state.watchdog);
    state.watchdog = null;
  }
  state.inFlight = false;
  if (state.queued) {
    state.queued = false;
    // Go through the debounce again so a burst that arrived mid-restart still
    // collapses into a single follow-up.
    requestRestart("queued rebuild");
  }
}

/**
 * Restart the Electron main process after this target rebuilds.
 *
 * Preload counts too, deliberately: a reloaded renderer talking to a stale
 * main-process IPC contract is the subtle half-broken state worth preventing,
 * and it is cheap to avoid.
 *
 * @param label which build asked -- shows up in the restart log line.
 */
export function hotRestart(label: string): Plugin {
  let builds = 0;
  let failed = false;

  return {
    name: "mcpjam:hot-restart",
    buildStart() {
      builds += 1;
      failed = false;
    },
    buildEnd(error) {
      if (error) failed = true;
    },
    renderError() {
      failed = true;
    },
    // `writeBundle`, NOT `closeBundle`. `closeBundle` also runs after a FAILED
    // build, which would restart Electron onto the last good bundle and make a
    // syntax error look like a no-op edit. `writeBundle` only runs when output
    // was actually written; the `failed` flag above is belt-and-braces for a
    // partial-output case.
    writeBundle() {
      if (failed) return;
      // Build #1 is the one forge does before it spawns Electron at all.
      // There is nothing to restart, and forge's handler would no-op on a null
      // child anyway.
      if (builds <= 1) return;
      requestRestart(label);
    },
  };
}
