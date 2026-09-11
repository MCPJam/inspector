import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attemptStaleChunkRecovery,
  installStaleChunkRecovery,
  isStaleChunkError,
  RELOAD_COOLDOWN_MS,
} from "../stale-chunk";

const reload = vi.fn();

function stubReload() {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
}

describe("isStaleChunkError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://staging.mcpjam.com/assets/highlighted-body-OFNGDK62-BtUjfQ3T.js",
    "error loading dynamically imported module: /assets/x.js",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/x.css",
    'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
  ])("matches %s", (message) => {
    expect(isStaleChunkError(new Error(message))).toBe(true);
    expect(isStaleChunkError(message)).toBe(true);
  });

  it("matches a webpack-style ChunkLoadError by name", () => {
    const error = new Error("boom");
    error.name = "ChunkLoadError";
    expect(isStaleChunkError(error)).toBe(true);
  });

  it.each([null, undefined, 42, {}, new Error("route exploded")])(
    "does not match %s",
    (value) => {
      expect(isStaleChunkError(value)).toBe(false);
    },
  );
});

describe("attemptStaleChunkRecovery", () => {
  beforeEach(() => {
    reload.mockClear();
    window.sessionStorage.clear();
    stubReload();
  });

  afterEach(() => vi.useRealTimers());

  it("reloads the document the first time", () => {
    expect(attemptStaleChunkRecovery()).toBe("reloading");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("refuses a second reload inside the cooldown, so a missing asset cannot loop", () => {
    attemptStaleChunkRecovery();
    reload.mockClear();

    expect(attemptStaleChunkRecovery()).toBe("cooldown");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads again once the cooldown has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    attemptStaleChunkRecovery();
    reload.mockClear();

    vi.setSystemTime(new Date(RELOAD_COOLDOWN_MS + 1));

    expect(attemptStaleChunkRecovery()).toBe("reloading");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the cooldown cannot be persisted", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });

    expect(attemptStaleChunkRecovery()).toBe("cooldown");
    expect(reload).not.toHaveBeenCalled();

    setItem.mockRestore();
  });
});

describe("installStaleChunkRecovery", () => {
  beforeEach(() => {
    reload.mockClear();
    window.sessionStorage.clear();
    stubReload();
  });

  it("recovers from a rejected dynamic import nothing else catches", () => {
    installStaleChunkRecovery();

    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        promise: Promise.resolve(),
        reason: new Error(
          "Failed to fetch dynamically imported module: /assets/x.js",
        ),
      }),
    );

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores an unrelated rejection", () => {
    installStaleChunkRecovery();

    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        promise: Promise.resolve(),
        reason: new Error("convex query failed"),
      }),
    );

    expect(reload).not.toHaveBeenCalled();
  });

  it("recovers from a Vite preload failure", () => {
    installStaleChunkRecovery();

    const event = Object.assign(new Event("vite:preloadError"), {
      payload: new Error("Unable to preload CSS for /assets/x.css"),
    });
    window.dispatchEvent(event);

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
