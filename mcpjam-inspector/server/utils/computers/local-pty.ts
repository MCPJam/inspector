/**
 * node-pty loader + availability probe for the local computer terminal.
 *
 * `node-pty` is an OPTIONAL dependency with a native addon. Every way this
 * inspector ships can legitimately fail to provide it, and none of them may
 * crash:
 *  - `npx @mcpjam/inspector` on a machine with no build toolchain — npm skips
 *    the optional dep and the install still succeeds.
 *  - The packaged Electron app — `@electron-forge/plugin-vite` packages only
 *    `.vite`, so there is no `node_modules` in the asar at all and the runtime
 *    require always fails. Electron is terminal-degrade by design in v1; real
 *    support needs `extraResource` + custom resolution and is a follow-up.
 *  - An ABI mismatch after a Node upgrade.
 *
 * So the contract is: probe once, cache the answer, and degrade to bash-only.
 * `getLocalTerminalAvailability()` is what the config route and the WS handler
 * both consult — it also reports unavailable whenever the local ENGINE itself
 * is unavailable (hosted, kill switch off, no bash), because a terminal on a
 * machine that may not execute bash would be a second, ungated execution path.
 */
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { logger } from "../logger.js";
import { isLocalComputerEngineAvailable } from "./local-machine.js";

/** The slice of node-pty's surface this server uses. */
export interface NodePtyProcess {
  pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ): NodePtyProcess;
}

export type LocalPtyModuleLoad =
  { ok: true; pty: NodePtyModule } | { ok: false; reason: string };

let loadPromise: Promise<LocalPtyModuleLoad> | null = null;

/**
 * Lazily `import("node-pty")`, memoized (including the failure — a missing
 * native addon will not appear mid-process, and retrying per connection would
 * pay the resolution cost on every socket).
 */
/**
 * npm's published node-pty prebuilds have shipped `spawn-helper` without its
 * execute bit (npm preserves the mode packed into the tarball). On macOS
 * node-pty exec's that helper for every PTY, so the module LOADS fine — the
 * availability probe passes — and every spawn then dies with the bare
 * `posix_spawnp failed.`. The repair is a one-bit chmod on a file inside our
 * own node_modules, so do it once at load rather than leaving every affected
 * install to diagnose it. Best-effort: any failure here falls through to the
 * spawn error, which the WS handler surfaces to the terminal pane.
 */
function repairSpawnHelperMode(): void {
  if (process.platform !== "darwin") return;
  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve("node-pty/package.json"));
    for (const helper of [
      path.join(root, "prebuilds", `darwin-${process.arch}`, "spawn-helper"),
      path.join(root, "build", "Release", "spawn-helper"),
    ]) {
      try {
        const mode = statSync(helper).mode;
        if ((mode & 0o111) === 0) {
          chmodSync(helper, mode | 0o111);
          logger.info("[local-pty] restored execute bit on spawn-helper", {
            helper,
          });
        }
      } catch {
        // Candidate absent (other build layout) or chmod refused — the spawn
        // error stays the source of truth.
      }
    }
  } catch {
    // node-pty itself not resolvable — the import below reports that.
  }
}

export function loadLocalPtyModule(): Promise<LocalPtyModuleLoad> {
  if (!loadPromise) {
    repairSpawnHelperMode();
    // `as string` widens the specifier for TYPE resolution only — node-pty is
    // optional, so `tsc` must not fail when it isn't installed (and must not
    // fight the package's own types when it is). The cast is erased before
    // esbuild/Rollup see the AST, so both still read a string literal and honor
    // the `node-pty` entry in their `external` lists.
    loadPromise = import("node-pty" as string)
      .then((mod): LocalPtyModuleLoad => {
        // ESM/CJS interop: the native addon is CommonJS, so `spawn` may live on
        // the namespace or on `default` depending on the loader.
        const candidate = (mod as { default?: unknown }).default ?? mod;
        const spawn = (candidate as Partial<NodePtyModule>).spawn;
        if (typeof spawn !== "function") {
          return { ok: false, reason: "node-pty did not export spawn()" };
        }
        return { ok: true, pty: candidate as NodePtyModule };
      })
      .catch((error): LocalPtyModuleLoad => {
        const reason =
          error instanceof Error ? error.message : "node-pty is not installed";
        logger.debug("[local-pty] node-pty unavailable", { reason });
        return {
          ok: false,
          reason: "node-pty is not available on this server",
        };
      });
  }
  return loadPromise;
}

export type LocalTerminalAvailability =
  { available: true } | { available: false; reason: string };

let cachedAvailability: LocalTerminalAvailability | undefined;

/**
 * Can this server open a local PTY? Cached for the process lifetime — the
 * config route calls this on every SPA boot and the answer cannot change
 * without a restart.
 */
export async function getLocalTerminalAvailability(): Promise<LocalTerminalAvailability> {
  if (cachedAvailability !== undefined) return cachedAvailability;
  const engine = isLocalComputerEngineAvailable();
  if (!engine.available) {
    cachedAvailability = { available: false, reason: engine.reason };
    return cachedAvailability;
  }
  const loaded = await loadLocalPtyModule();
  cachedAvailability = loaded.ok
    ? { available: true }
    : { available: false, reason: loaded.reason };
  return cachedAvailability;
}

/** Test seam: both the module load and the probe are process-lifetime caches. */
export function resetLocalPtyCachesForTests(): void {
  loadPromise = null;
  cachedAvailability = undefined;
}

/** Test seam: inject a fake node-pty module (the native addon isn't installable in CI). */
export function setLocalPtyModuleForTests(module: NodePtyModule | null): void {
  loadPromise = module
    ? Promise.resolve({ ok: true, pty: module })
    : Promise.resolve({
        ok: false,
        reason: "node-pty is not available on this server",
      });
  cachedAvailability = undefined;
}
