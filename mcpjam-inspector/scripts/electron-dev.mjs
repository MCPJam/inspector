#!/usr/bin/env node
/**
 * `npm run electron:dev`: start the desktop app in development on an embedded
 * server port of its own.
 *
 *   npm run electron:dev -w @mcpjam/inspector [-- --server-port N] [forge args]
 *
 * The embedded Hono server used to be pinned to 6274 in two places that could
 * not see each other: the main process probed 6274.. for a free port, while the
 * renderer's Vite proxy (`vite.renderer.config.mts`) pointed at 6274 no matter
 * what. With `npm run dev` already holding 6274, main fell back to 6275 and the
 * window kept talking to the web app's server: its login, refresh and guest
 * session all landed in the other instance.
 *
 * This launcher picks the free port ONCE, before forge starts, and hands it to
 * both sides through `SERVER_PORT`: the renderer proxies to it, and main starts
 * probing from it (`resolveServerStartPort` in `src/server-port-fallback.ts`).
 * The main process then derives this instance's session namespace and callback
 * origins from the port it bound, the same way `bin/start.js` does.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SERVER_PORT = 6274;
const FALLBACK_ATTEMPTS = 10;

export function parseElectronDevArgs(argv) {
  const forgeArgs = [];
  let serverPort;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let raw;
    if (arg === "--server-port") {
      raw = argv[++i];
    } else if (arg.startsWith("--server-port=")) {
      raw = arg.slice("--server-port=".length);
    } else {
      forgeArgs.push(arg);
      continue;
    }
    if (!/^\d+$/.test(raw ?? "") || Number(raw) < 1 || Number(raw) > 65535) {
      throw new Error(
        `--server-port must be a port number between 1 and 65535 (got "${raw ?? ""}").`,
      );
    }
    serverPort = Number(raw);
  }
  return { serverPort, forgeArgs };
}

/** Can `port` be bound on `host`? A host this machine lacks (no IPv6) counts as free. */
function probe(port, host) {
  return new Promise((resolvePromise) => {
    const server = net.createServer();
    server.once("error", (error) => {
      resolvePromise(
        error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT",
      );
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

export async function isPortFree(port) {
  return (await probe(port, "127.0.0.1")) && (await probe(port, "::1"));
}

/**
 * The first free port from `start`, trying `attempts` consecutive ports — the
 * same walk `src/main.ts` performs, done here so the renderer learns the
 * answer too.
 */
export async function findFreeServerPort({
  start = DEFAULT_SERVER_PORT,
  attempts = FALLBACK_ATTEMPTS,
  isFree = isPortFree,
} = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const port = start + i;
    if (port > 65535) break;
    if (await isFree(port)) return port;
  }
  throw new Error(
    `No free server port in ${start}..${start + attempts - 1}; pass --server-port N.`,
  );
}

/**
 * Set for the main process when the renderer's proxy is already pinned to
 * SERVER_PORT. Mirrors `SERVER_PORT_PINNED_ENV` in `src/server-port-fallback.ts`.
 */
export const SERVER_PORT_PINNED_ENV = "MCPJAM_SERVER_PORT_PINNED";

/**
 * The ONE port both the renderer proxy and the main process will use.
 *
 * An explicit `--server-port N` is a promise to the renderer: its proxy
 * targets N. If N is already taken, the only safe answer is to refuse:
 * starting anyway would let main fall forward to N+1 while the window keeps
 * calling N, i.e. some other Inspector (the bug this launcher exists to fix).
 * Without an explicit port, the first free port from `start` is chosen.
 */
export async function resolveLaunchServerPort({
  explicitPort,
  start = DEFAULT_SERVER_PORT,
  isFree = isPortFree,
} = {}) {
  if (explicitPort !== undefined) {
    if (!(await isFree(explicitPort))) {
      throw new Error(
        `--server-port ${explicitPort} is already in use (another Inspector?). ` +
          "Pick a free port, or omit --server-port to have one chosen for you.",
      );
    }
    return explicitPort;
  }
  return findFreeServerPort({ start, isFree });
}

/** electron-forge's JS entry, run with this Node: no shell, no Windows .cmd shim. */
function forgeCliEntry() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@electron-forge/cli/package.json");
  const manifest = require(manifestPath);
  return join(dirname(manifestPath), manifest.bin["electron-forge"]);
}

async function main() {
  const inspectorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let args;
  let port;
  try {
    args = parseElectronDevArgs(process.argv.slice(2));
    port = await resolveLaunchServerPort({
      explicitPort: args.serverPort,
      start:
        process.env.SERVER_PORT && /^\d+$/.test(process.env.SERVER_PORT)
          ? Number(process.env.SERVER_PORT)
          : DEFAULT_SERVER_PORT,
    });
  } catch (error) {
    process.stderr.write(`electron:dev: ${error.message}\n`);
    process.exit(1);
  }
  if (port !== DEFAULT_SERVER_PORT) {
    process.stdout.write(
      `electron:dev: port ${DEFAULT_SERVER_PORT} is taken; the embedded server will use :${port} ` +
        "and the window will talk to it (not to the other Inspector).\n",
    );
  }

  const child = spawn(
    process.execPath,
    [forgeCliEntry(), "start", ...args.forgeArgs],
    {
      cwd: inspectorDir,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "development",
        SERVER_PORT: String(port),
        // The renderer's proxy already points at exactly this port, so main
        // must bind it or fail; falling forward to the next port would split
        // the window from its own server (`resolveServerPortAttempts`).
        [SERVER_PORT_PINNED_ENV]: "1",
      },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (child.exitCode === null) child.kill(signal);
    });
  }
  child.once("error", (error) => {
    process.stderr.write(`electron:dev: failed to start forge: ${error.message}\n`);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
