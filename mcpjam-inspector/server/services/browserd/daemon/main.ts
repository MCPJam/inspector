/**
 * The mcpjam-browserd entrypoint.
 *
 * Reads its config from `envs`, launches the persistent Chromium context, wraps
 * it in the ChromiumDriver, binds the control-plane server, and prints the
 * stdout ready-line the boot recipe waits on. Bundled to a single ESM file by
 * `scripts/bundle-browserd.mjs` with `playwright` left external (it is installed
 * in the desktop template). This module is the side-effectful bootstrap; the
 * pure parsing lives in `config.ts` so it can be tested without booting a
 * browser.
 */
import { buildBrowserdStack } from "./server";
import { ChromiumDriver } from "./chromium-driver";
import { launchBrowserdContext } from "./chromium-launch";
import { HandoffLease } from "./lease";
import {
  extraArgsFor,
  formatReadyLine,
  readBrowserdConfig,
  readBundleHash,
} from "./config";
import { BROWSERD_PROTOCOL_VERSION } from "../protocol";

function log(message: string): void {
  process.stderr.write(`[mcpjam-browserd] ${message}\n`);
}

async function main(): Promise<void> {
  const config = readBrowserdConfig();
  const bundleHash = readBundleHash();
  const context = await launchBrowserdContext({
    userDataDir: config.userDataDir,
    headless: config.headless,
    extraArgs: extraArgsFor(config),
    contextMode: config.contextMode,
  });
  // One lease, shared by the handler (which blocks commands while a person
  // holds the browser) and the driver (which makes the first observation after
  // they hand it back loud).
  const lease = new HandoffLease();
  const driver = new ChromiumDriver(context, { lease });
  const stack = buildBrowserdStack(driver, {
    token: config.token,
    lease,
    // Read ONCE, at boot: the file cannot change under a running process in
    // any way that would make a later read more truthful, and hashing a
    // multi-megabyte bundle on every status probe would tax a box the agent is
    // also using.
    ...(bundleHash ? { bundleHash } : {}),
    contextMode: config.contextMode,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Streams first: `server.close()` stops accepting and then waits on open
    // connections, and a frame stream never ends on its own. Ending them says
    // `shutting_down` in-band too, so a watcher knows the daemon went away
    // rather than inferring it from a socket that stopped.
    stack.closeStreams();
    stack.server.close();
    await driver.close().catch(() => {});
    log(`shut down on ${signal}`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  stack.server.listen(config.port, config.host, () => {
    // The boot recipe blocks on this line to learn the daemon is up + its bootId.
    process.stdout.write(
      `${formatReadyLine(
        config.host,
        config.port,
        stack.bootId,
        BROWSERD_PROTOCOL_VERSION,
      )}\n`,
    );
  });
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
