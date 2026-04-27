import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkForUpdates,
  getUpdateCacheDir,
  isNewerVersion,
  isUpdateCacheFresh,
  readUpdateCache,
  shouldSkipUpdateCheck,
  spawnBackgroundFetch,
  UPDATE_CHECK_INTERVAL_MS,
  type SpawnBackgroundFetch,
} from "../src/lib/update-notifier.js";

function withTempDir(fn: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "mcpjam-update-notifier-"));
  try {
    fn(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeCache(
  cachePath: string,
  cache: {
    latestVersion: string;
    checkedAt: number;
  },
) {
  writeFileSync(cachePath, JSON.stringify(cache), "utf8");
}

test("isNewerVersion compares only stable semver versions", () => {
  assert.equal(isNewerVersion("3.1.0", "3.0.0"), true);
  assert.equal(isNewerVersion("4.0.0", "3.9.9"), true);
  assert.equal(isNewerVersion("v3.0.1", "3.0.0"), true);
  assert.equal(isNewerVersion("3.0.0", "3.0.0"), false);
  assert.equal(isNewerVersion("2.9.9", "3.0.0"), false);
  assert.equal(isNewerVersion("3.1.0-beta.1", "3.0.0"), false);
  assert.equal(isNewerVersion("3.1", "3.0.0"), false);
  assert.equal(isNewerVersion("3.1.0", "not-a-version"), false);
  assert.equal(isNewerVersion(undefined, "3.0.0"), false);
});

test("getUpdateCacheDir follows OS cache conventions", () => {
  assert.equal(
    getUpdateCacheDir({
      env: {},
      platform: "linux",
      homeDirectory: "/home/mcpjam",
    }),
    join("/home/mcpjam", ".cache", "mcpjam"),
  );
  assert.equal(
    getUpdateCacheDir({
      env: {
        XDG_CACHE_HOME: "/tmp/xdg-cache",
      },
      platform: "linux",
      homeDirectory: "/home/mcpjam",
    }),
    join("/tmp/xdg-cache", "mcpjam"),
  );
  assert.equal(
    getUpdateCacheDir({
      env: {},
      platform: "darwin",
      homeDirectory: "/Users/mcpjam",
    }),
    join("/Users/mcpjam", "Library", "Caches", "mcpjam"),
  );
  assert.equal(
    getUpdateCacheDir({
      env: {
        LOCALAPPDATA: "C:\\Users\\mcpjam\\AppData\\Local",
      },
      platform: "win32",
      homeDirectory: "C:\\Users\\mcpjam",
    }),
    join("C:\\Users\\mcpjam\\AppData\\Local", "mcpjam", "Cache"),
  );
});

test("readUpdateCache returns valid cache data and ignores invalid cache files", () => {
  withTempDir((directory) => {
    const validCachePath = join(directory, "valid.json");
    writeCache(validCachePath, {
      latestVersion: "3.1.0",
      checkedAt: 1_000,
    });
    assert.deepEqual(readUpdateCache(validCachePath), {
      latestVersion: "3.1.0",
      checkedAt: 1_000,
    });

    assert.equal(readUpdateCache(join(directory, "missing.json")), null);

    const corruptCachePath = join(directory, "corrupt.json");
    writeFileSync(corruptCachePath, "{", "utf8");
    assert.equal(readUpdateCache(corruptCachePath), null);

    const invalidSchemaPath = join(directory, "invalid-schema.json");
    writeFileSync(
      invalidSchemaPath,
      JSON.stringify({
        latestVersion: 3,
        checkedAt: "yesterday",
      }),
      "utf8",
    );
    assert.equal(readUpdateCache(invalidSchemaPath), null);
  });
});

test("isUpdateCacheFresh uses the 24 hour freshness window", () => {
  assert.equal(
    isUpdateCacheFresh(
      {
        latestVersion: "3.1.0",
        checkedAt: 10_000,
      },
      10_000 + UPDATE_CHECK_INTERVAL_MS - 1,
    ),
    true,
  );
  assert.equal(
    isUpdateCacheFresh(
      {
        latestVersion: "3.1.0",
        checkedAt: 10_000,
      },
      10_000 + UPDATE_CHECK_INTERVAL_MS,
    ),
    false,
  );
});

test("shouldSkipUpdateCheck respects CI, opt-out env vars, and non-TTY stderr", () => {
  assert.equal(shouldSkipUpdateCheck({ env: {}, isStderrTTY: true }), false);
  assert.equal(shouldSkipUpdateCheck({ env: {}, isStderrTTY: false }), true);
  assert.equal(
    shouldSkipUpdateCheck({ env: { CI: "true" }, isStderrTTY: true }),
    true,
  );
  assert.equal(
    shouldSkipUpdateCheck({
      env: { NO_UPDATE_NOTIFIER: "1" },
      isStderrTTY: true,
    }),
    true,
  );
  assert.equal(
    shouldSkipUpdateCheck({
      env: { MCPJAM_NO_UPDATE_CHECK: "1" },
      isStderrTTY: true,
    }),
    true,
  );
});

test("checkForUpdates prints a fresh newer cached version to stderr", () => {
  withTempDir((directory) => {
    const cachePath = join(directory, "cache.json");
    const spawns: string[] = [];
    let stderr = "";
    writeCache(cachePath, {
      latestVersion: "3.1.0",
      checkedAt: 1_000,
    });

    checkForUpdates("3.0.0", {
      cachePath,
      env: {},
      isStderrTTY: true,
      now: 1_000,
      stderr: {
        write(chunk) {
          stderr += chunk;
          return true;
        },
      },
      spawnBackgroundFetch(path) {
        spawns.push(path);
      },
    });

    assert.match(stderr, /Update available: @mcpjam\/cli 3\.0\.0 -> 3\.1\.0/);
    assert.match(stderr, /Run npm install -g @mcpjam\/cli to update/);
    assert.deepEqual(spawns, []);
  });
});

test("checkForUpdates stays quiet for fresh same or older cached versions", () => {
  withTempDir((directory) => {
    const cachePath = join(directory, "cache.json");
    let stderr = "";
    let spawnCount = 0;
    writeCache(cachePath, {
      latestVersion: "3.0.0",
      checkedAt: 1_000,
    });

    checkForUpdates("3.0.0", {
      cachePath,
      env: {},
      isStderrTTY: true,
      now: 1_000,
      stderr: {
        write(chunk) {
          stderr += chunk;
          return true;
        },
      },
      spawnBackgroundFetch() {
        spawnCount += 1;
      },
    });

    assert.equal(stderr, "");
    assert.equal(spawnCount, 0);
  });
});

test("checkForUpdates spawns a background fetch for stale or missing cache", () => {
  withTempDir((directory) => {
    const staleCachePath = join(directory, "stale.json");
    const missingCachePath = join(directory, "missing.json");
    const spawns: string[] = [];
    let stderr = "";
    writeCache(staleCachePath, {
      latestVersion: "3.1.0",
      checkedAt: 1_000,
    });

    const spawn: SpawnBackgroundFetch = (cachePath) => {
      spawns.push(cachePath);
    };

    checkForUpdates("3.0.0", {
      cachePath: staleCachePath,
      env: {},
      isStderrTTY: true,
      now: 1_000 + UPDATE_CHECK_INTERVAL_MS,
      stderr: {
        write(chunk) {
          stderr += chunk;
          return true;
        },
      },
      spawnBackgroundFetch: spawn,
    });
    checkForUpdates("3.0.0", {
      cachePath: missingCachePath,
      env: {},
      isStderrTTY: true,
      now: 1_000,
      stderr: {
        write(chunk) {
          stderr += chunk;
          return true;
        },
      },
      spawnBackgroundFetch: spawn,
    });

    assert.equal(stderr, "");
    assert.deepEqual(spawns, [staleCachePath, missingCachePath]);
  });
});

test("checkForUpdates skips both notice and fetch when disabled", () => {
  withTempDir((directory) => {
    const cachePath = join(directory, "cache.json");
    let stderr = "";
    let spawnCount = 0;
    writeCache(cachePath, {
      latestVersion: "3.1.0",
      checkedAt: 1_000,
    });

    checkForUpdates("3.0.0", {
      cachePath,
      env: {
        MCPJAM_NO_UPDATE_CHECK: "1",
      },
      isStderrTTY: true,
      now: 1_000,
      stderr: {
        write(chunk) {
          stderr += chunk;
          return true;
        },
      },
      spawnBackgroundFetch() {
        spawnCount += 1;
      },
    });

    assert.equal(stderr, "");
    assert.equal(spawnCount, 0);
  });
});

test("spawnBackgroundFetch starts a detached node process with positional args", () => {
  let command = "";
  let args: readonly string[] = [];
  let options: unknown;
  let registeredEvent = "";
  let unrefCalled = false;
  const child = {
    on(event: string) {
      registeredEvent = event;
      return child;
    },
    unref() {
      unrefCalled = true;
    },
  };

  spawnBackgroundFetch("/tmp/update-cache.json", "@mcpjam/cli", {
    execPath: "/usr/bin/node",
    spawn: ((
      nextCommand: string,
      nextArgs?: readonly string[],
      nextOptions?: unknown,
    ) => {
      command = nextCommand;
      args = nextArgs ?? [];
      options = nextOptions;
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
  });

  assert.equal(command, "/usr/bin/node");
  assert.equal(args[0], "-e");
  assert.equal(args[2], "/tmp/update-cache.json");
  assert.equal(args[3], "@mcpjam/cli");
  assert.deepEqual(options, {
    detached: true,
    stdio: "ignore",
  });
  assert.equal(registeredEvent, "error");
  assert.equal(unrefCalled, true);
});
