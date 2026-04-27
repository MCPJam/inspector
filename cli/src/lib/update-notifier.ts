import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_UPDATE_PACKAGE_NAME = "@mcpjam/cli";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface UpdateCheckCache {
  latestVersion: string;
  checkedAt: number;
}

export interface SkipUpdateCheckOptions {
  env?: NodeJS.ProcessEnv;
  isStderrTTY?: boolean;
}

export type StderrLike = {
  write(chunk: string): unknown;
};

export type SpawnBackgroundFetch = (
  cachePath: string,
  packageName: string,
) => void;

export interface UpdateNotifierOptions extends SkipUpdateCheckOptions {
  packageName?: string;
  cachePath?: string;
  now?: number | (() => number);
  stderr?: StderrLike;
  spawnBackgroundFetch?: SpawnBackgroundFetch;
}

export interface CachePathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}

export interface SpawnBackgroundFetchOptions {
  execPath?: string;
  spawn?: typeof spawnChild;
}

const UPDATE_CACHE_FILE = "update-check.json";

// Keep this inline so the tsup single-file CLI bundle contains the fetcher.
const BACKGROUND_FETCH_SCRIPT = `
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const cachePath = process.argv[1];
const packageName = process.argv[2];

if (!cachePath || !packageName) {
  process.exit(0);
}

const maxResponseBytes = 1024 * 1024;
const registryPackageName = encodeURIComponent(packageName);
const request = https.get(
  "https://registry.npmjs.org/" + registryPackageName + "/latest",
  {
    headers: {
      accept: "application/json",
      "user-agent": packageName + " update notifier",
    },
  },
  (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      return;
    }

    const chunks = [];
    let bytes = 0;

    response.on("error", () => {});
    response.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxResponseBytes) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    response.on("end", () => {
      try {
        const body = Buffer.concat(chunks, bytes).toString("utf8");
        const payload = JSON.parse(body);
        if (typeof payload.version !== "string") {
          return;
        }

        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        const temporaryPath = cachePath + "." + process.pid + ".tmp";
        fs.writeFileSync(
          temporaryPath,
          JSON.stringify({
            latestVersion: payload.version,
            checkedAt: Date.now(),
          }),
          "utf8",
        );
        fs.renameSync(temporaryPath, cachePath);
      } catch {
        // Silently ignore: update cache refresh is best-effort.
      }
    });
  },
);

request.setTimeout(2500, () => {
  request.destroy();
});
request.on("error", () => {});
`;

export function getUpdateCacheDir(options: CachePathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();

  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA || join(homeDirectory, "AppData", "Local"),
      "mcpjam",
      "Cache",
    );
  }

  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Caches", "mcpjam");
  }

  return join(env.XDG_CACHE_HOME || join(homeDirectory, ".cache"), "mcpjam");
}

export function getUpdateCachePath(options: CachePathOptions = {}): string {
  return join(getUpdateCacheDir(options), UPDATE_CACHE_FILE);
}

export function readUpdateCache(cachePath: string): UpdateCheckCache | null {
  try {
    const payload = JSON.parse(readFileSync(cachePath, "utf8"));

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.latestVersion !== "string" ||
      typeof payload.checkedAt !== "number" ||
      !Number.isFinite(payload.checkedAt)
    ) {
      return null;
    }

    return {
      latestVersion: payload.latestVersion,
      checkedAt: payload.checkedAt,
    };
  } catch {
    // Silently ignore malformed or missing cache data; update checks are best-effort.
    return null;
  }
}

export function isUpdateCacheFresh(
  cache: UpdateCheckCache,
  now = Date.now(),
): boolean {
  return now - cache.checkedAt < UPDATE_CHECK_INTERVAL_MS;
}

export function shouldSkipUpdateCheck(
  options: SkipUpdateCheckOptions = {},
): boolean {
  const env = options.env ?? process.env;
  const isStderrTTY = options.isStderrTTY ?? Boolean(process.stderr.isTTY);

  return Boolean(
    env.CI ||
      env.NO_UPDATE_NOTIFIER ||
      env.MCPJAM_NO_UPDATE_CHECK ||
      !isStderrTTY,
  );
}

export function isNewerVersion(latest: unknown, current: unknown): boolean {
  const latestVersion = parseStableVersion(latest);
  const currentVersion = parseStableVersion(current);

  if (!latestVersion || !currentVersion) {
    return false;
  }

  for (let index = 0; index < latestVersion.length; index += 1) {
    if (latestVersion[index] > currentVersion[index]) {
      return true;
    }
    if (latestVersion[index] < currentVersion[index]) {
      return false;
    }
  }

  return false;
}

export function spawnBackgroundFetch(
  cachePath: string,
  packageName = DEFAULT_UPDATE_PACKAGE_NAME,
  options: SpawnBackgroundFetchOptions = {},
): void {
  try {
    const spawn = options.spawn ?? spawnChild;
    const child = spawn(
      options.execPath ?? process.execPath,
      ["-e", BACKGROUND_FETCH_SCRIPT, cachePath, packageName],
      {
        detached: true,
        stdio: "ignore",
      },
    ) as ChildProcess;

    child.on("error", () => {});
    child.unref();
  } catch {
    // Silently ignore spawn failures; the CLI command has already completed.
  }
}

export function printUpdateNotification(
  currentVersion: string,
  latestVersion: string,
  packageName = DEFAULT_UPDATE_PACKAGE_NAME,
  stderr: StderrLike = process.stderr,
): void {
  stderr.write(
    `Update available: ${packageName} ${currentVersion} -> ${latestVersion}\n` +
      `Run npm install -g ${packageName} to update\n`,
  );
}

export function checkForUpdates(
  currentVersion: string,
  options: UpdateNotifierOptions = {},
): void {
  try {
    const env = options.env ?? process.env;

    if (
      shouldSkipUpdateCheck({
        env,
        isStderrTTY: options.isStderrTTY,
      })
    ) {
      return;
    }

    const now =
      typeof options.now === "function"
        ? options.now()
        : options.now ?? Date.now();
    const packageName = options.packageName ?? DEFAULT_UPDATE_PACKAGE_NAME;
    const cachePath =
      options.cachePath ??
      getUpdateCachePath({
        env,
      });
    const cache = readUpdateCache(cachePath);

    if (cache) {
      const hasNewerCachedVersion = isNewerVersion(
        cache.latestVersion,
        currentVersion,
      );

      if (hasNewerCachedVersion) {
        printUpdateNotification(
          currentVersion,
          cache.latestVersion,
          packageName,
          options.stderr,
        );
      }

      if (isUpdateCacheFresh(cache, now)) {
        return;
      }
    }

    const fetchSpawner = options.spawnBackgroundFetch ?? spawnBackgroundFetch;
    fetchSpawner(cachePath, packageName);
  } catch {
    // Silently ignore all notifier failures; update checks must never break CLI runs.
  }
}

function parseStableVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.startsWith("v") ? value.slice(1) : value;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(normalized);

  if (!match) {
    return null;
  }

  const parts = match.slice(1).map((part) => Number(part));
  if (!parts.every((part) => Number.isSafeInteger(part) && part >= 0)) {
    return null;
  }

  return [parts[0], parts[1], parts[2]];
}
