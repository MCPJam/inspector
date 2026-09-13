import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Plugin } from "vite";
import { hotRestart, notifyRestartComplete } from "../vite.dev-plugins";

/**
 * The restart mechanism is `process.stdin.emit("data", "rs")` -- the same event
 * forge's own interactive handler listens for. That makes it directly testable
 * without Electron: count the `rs` emissions a sequence of rebuilds produces.
 *
 * What is actually being pinned here is the set of behaviours that separate this
 * from a one-line `closeBundle() { emit("rs") }`: no restart on the pre-spawn
 * build, no restart after a failed build, one restart for a burst, and no
 * overlapping restarts (forge stacks an `'exit'` listener per `rs`, so two in
 * flight leave one respawning a process nobody tracks).
 */

/** Our plugin's hooks are plain functions, so a test can drive them directly. */
type Hooks = {
  buildStart: () => void;
  buildEnd: (error?: Error) => void;
  renderError: () => void;
  writeBundle: () => void;
};

const asHooks = (plugin: Plugin) => plugin as unknown as Hooks;

/** One complete successful rebuild of a target. */
function rebuild(hooks: Hooks) {
  hooks.buildStart();
  hooks.buildEnd();
  hooks.writeBundle();
}

/** A rebuild that fails while building the module graph. */
function failedBuild(hooks: Hooks) {
  hooks.buildStart();
  hooks.buildEnd(new Error("Unexpected token"));
  // Rollup does not call writeBundle for a failed build. Call it anyway: the
  // plugin must not restart even if some future Rollup does.
  hooks.writeBundle();
}

const DEBOUNCE_MS = 250;
const WATCHDOG_MS = 10_000;

let restarts: number;
let stderr: string[];
let countRestart: (chunk: unknown) => void;

beforeEach(() => {
  vi.useFakeTimers();
  // The scheduler deliberately lives on globalThis (three config files, three
  // module scopes, one process), so it has to be reset between tests.
  delete (globalThis as Record<symbol, unknown>)[
    Symbol.for("mcpjam.forge.hotRestart")
  ];
  delete process.env.MCPJAM_ELECTRON_DEV_NO_RESTART;

  restarts = 0;
  stderr = [];
  countRestart = (chunk) => {
    if (String(chunk).trim() === "rs") restarts += 1;
  };
  process.stdin.on("data", countRestart);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  process.stdin.off("data", countRestart);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Let the debounce elapse. */
const settle = () => vi.advanceTimersByTime(DEBOUNCE_MS + 1);

describe("hotRestart", () => {
  it("does not restart after the build that precedes the first spawn", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    settle();
    expect(restarts).toBe(0);
  });

  it("restarts once for one rebuild", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main); // build #1: forge has not spawned Electron yet
    rebuild(main); // build #2: a real save
    settle();
    expect(restarts).toBe(1);
    expect(stderr.join("")).toContain("restart #1 (main)");
  });

  it("collapses a burst of rebuilds into one restart", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(60); // three saves inside one debounce window
      rebuild(main);
    }
    settle();
    expect(restarts).toBe(1);
  });

  it("collapses concurrent main and preload rebuilds into one restart", () => {
    // A `shared/` edit invalidates both graphs, and forge builds them
    // concurrently, so their writeBundles land milliseconds apart.
    const main = asHooks(hotRestart("main"));
    const preload = asHooks(hotRestart("preload"));
    rebuild(main);
    rebuild(preload);

    rebuild(main);
    vi.advanceTimersByTime(5);
    rebuild(preload);
    settle();

    expect(restarts).toBe(1);
    // Both are named, so the log says why.
    expect(stderr.join("")).toContain("main + preload");
  });

  it("restarts for a preload-only rebuild", () => {
    // Deliberate: a reloaded renderer against a stale main-process IPC
    // contract is the subtle half-updated state worth preventing.
    const preload = asHooks(hotRestart("preload"));
    rebuild(preload);
    rebuild(preload);
    settle();
    expect(restarts).toBe(1);
  });

  it("does not restart after a failed build", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    failedBuild(main);
    settle();
    expect(restarts).toBe(0);
  });

  it("does not restart when codegen fails after a clean graph", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    main.buildStart();
    main.buildEnd();
    main.renderError();
    main.writeBundle();
    settle();
    expect(restarts).toBe(0);
  });

  it("restarts on the rebuild that fixes a failed build", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    failedBuild(main);
    settle();
    expect(restarts).toBe(0);

    rebuild(main); // the fix
    settle();
    expect(restarts).toBe(1);
  });

  it("serializes restarts instead of overlapping them", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main);

    rebuild(main);
    settle();
    expect(restarts).toBe(1);

    // A save landing before forge reports the respawn must not emit a second
    // `rs`: forge's handler stacks an 'exit' listener per emission.
    rebuild(main);
    settle();
    expect(restarts).toBe(1);

    // postStart -- the respawn completed. The queued rebuild goes now.
    notifyRestartComplete();
    settle();
    expect(restarts).toBe(2);
  });

  it("queues at most one follow-up restart for a burst during a restart", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    rebuild(main);
    settle();
    expect(restarts).toBe(1);

    for (let i = 0; i < 4; i++) {
      rebuild(main);
      settle();
    }
    expect(restarts).toBe(1);

    notifyRestartComplete();
    settle();
    expect(restarts).toBe(2);
  });

  it("warns but KEEPS the lock when a restart never completes", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    rebuild(main);
    settle();
    expect(restarts).toBe(1);

    // postStart never arrives -- main wedged in a teardown handler.
    vi.advanceTimersByTime(WATCHDOG_MS + 1);
    expect(stderr.join("")).toMatch(/did not complete within 10s/);

    // The lock must NOT be released. Forge adds an `'exit'` listener to
    // `lastSpawned` per `rs`, and does not reassign `lastSpawned` until the
    // respawn finishes -- so a second `rs` before the first child exits makes
    // both listeners fire on the one exit and spawn two Electron processes, one
    // of them untracked. Parking auto-restart is the cheaper failure.
    rebuild(main);
    settle();
    expect(restarts).toBe(1);

    // It tells the developer how to recover, rather than going quiet.
    expect(stderr.join("")).toMatch(/re-run 'npm run electron:dev' to recover/);
  });

  it("recovers if a late postStart does arrive after the watchdog fired", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    rebuild(main);
    settle();
    vi.advanceTimersByTime(WATCHDOG_MS + 1);

    // The wedged child finally exited and forge respawned it.
    notifyRestartComplete();
    rebuild(main);
    settle();
    expect(restarts).toBe(2);
  });

  it("cancels the watchdog once the restart completes", () => {
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    rebuild(main);
    settle();
    notifyRestartComplete();

    vi.advanceTimersByTime(WATCHDOG_MS + 1);
    expect(stderr.join("")).not.toMatch(/did not complete/);
  });

  it("does nothing at all under MCPJAM_ELECTRON_DEV_NO_RESTART=1", () => {
    // For holding a breakpoint in the main process, which a restart drops.
    process.env.MCPJAM_ELECTRON_DEV_NO_RESTART = "1";
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    rebuild(main);
    settle();
    expect(restarts).toBe(0);
    expect(stderr.join("")).toBe("");
  });

  it("tolerates postStart arriving when nothing is in flight", () => {
    // Forge runs postStart for the FIRST spawn too.
    expect(() => notifyRestartComplete()).not.toThrow();
    const main = asHooks(hotRestart("main"));
    rebuild(main);
    rebuild(main);
    settle();
    expect(restarts).toBe(1);
  });
});
