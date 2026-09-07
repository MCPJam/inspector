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
import { createVideoEncoder } from "./video-encoder";
import { ChromiumDriver } from "./chromium-driver";
import { launchBrowserdContext } from "./chromium-launch";
import { HandoffLease } from "./lease";
import {
  extraArgsFor,
  formatReadyLine,
  readBrowserdConfig,
  readBundleHash,
} from "./config";
import {
  BROWSERD_OBSERVATION_VIEWPORT,
  BROWSERD_PROTOCOL_VERSION,
} from "../protocol";

function log(message: string): void {
  process.stderr.write(`[mcpjam-browserd] ${message}\n`);
}

/**
 * Does this daemon offer H.264, and may it?
 *
 * ANNOUNCED, never assumed by a caller: a relay that asked a daemon too old to
 * encode would get an error stream instead of a picture, and a reader cannot
 * tell that apart from a dead browser.
 *
 * Two static preconditions. The kill switch is the operator's. KIOSK is the
 * one that makes the encoder's premise true: it grabs the WHOLE X display, so
 * "the display IS the page" only holds when the window covers it with no
 * chrome — without kiosk the grab would be a desktop with a browser somewhere
 * on it, and every click the pane mapped would be off by the window's origin.
 *
 * ffmpeg's presence is NOT checked here, and deliberately: probing for a binary
 * at boot costs a process on every start, and the honest answer arrives anyway
 * — the first subscriber's spawn fails and that stream ends `video_unavailable`,
 * which is the same fallback a client with no `VideoDecoder` takes.
 */
/**
 * The X screen's size in DEVICE pixels.
 *
 * The display is the observation viewport scaled by the device scale factor:
 * Xvfb is started at that geometry and Chromium in kiosk fills it, which is
 * exactly the premise the encoder rests on. Derived rather than configured, so
 * the three numbers cannot drift apart.
 */
function displayWidth(config: { deviceScaleFactor: number }): number {
  return Math.round(BROWSERD_OBSERVATION_VIEWPORT.width * config.deviceScaleFactor);
}

function displayHeight(config: { deviceScaleFactor: number }): number {
  return Math.round(
    BROWSERD_OBSERVATION_VIEWPORT.height * config.deviceScaleFactor,
  );
}

function videoFeatures(config: {
  kiosk: boolean;
}): readonly string[] {
  if (process.env.MCPJAM_BROWSER_VIDEO === "false") return [];
  return config.kiosk ? ["h264"] : [];
}

async function main(): Promise<void> {
  const config = readBrowserdConfig();
  const bundleHash = readBundleHash();
  const context = await launchBrowserdContext({
    userDataDir: config.userDataDir,
    headless: config.headless,
    extraArgs: extraArgsFor(config),
    contextMode: config.contextMode,
    deviceScaleFactor: config.deviceScaleFactor,
  });
  // One lease, shared by the handler (which blocks commands while a person
  // holds the browser) and the driver (which makes the first observation after
  // they hand it back loud).
  const lease = new HandoffLease();
  const driver = new ChromiumDriver(context, { lease });
  // Created only when the box is configured for it, and STARTED only when a
  // watcher asks — `subscribe` spawns ffmpeg, `unsubscribe` of the last
  // watcher stops it. An encoder running for nobody is CPU the agent is also
  // trying to use.
  const features = videoFeatures(config);
  const video = features.includes("h264")
    ? createVideoEncoder({
        display: process.env.DISPLAY || ":0",
        width: displayWidth(config),
        height: displayHeight(config),
      })
    : undefined;
  const stack = buildBrowserdStack(driver, {
    token: config.token,
    lease,
    // Read ONCE, at boot: the file cannot change under a running process in
    // any way that would make a later read more truthful, and hashing a
    // multi-megabyte bundle on every status probe would tax a box the agent is
    // also using.
    ...(bundleHash ? { bundleHash } : {}),
    contextMode: config.contextMode,
    startedBy: config.startedBy,
    features,
    ...(video ? { video } : {}),
    displaySize: {
      width: displayWidth(config),
      height: displayHeight(config),
    },
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
    video?.dispose();
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
