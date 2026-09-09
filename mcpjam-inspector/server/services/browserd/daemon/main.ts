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
import { createVideoRecorder } from "./video-recorder";
import { ChromiumDriver } from "./chromium-driver";
import { launchBrowserdContext } from "./chromium-launch";
import { HandoffLease } from "./lease";
import { mkdirSync } from "node:fs";
import {
  announcedFeatures,
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
  // Announced, never assumed: see `announcedFeatures` for the two switches and
  // why they are independent of each other.
  const features = announcedFeatures(config);
  const video = features.includes("h264")
    ? createVideoEncoder({
        display: process.env.DISPLAY || ":0",
        width: displayWidth(config),
        height: displayHeight(config),
      })
    : undefined;
  // The recorder is its OWN ffmpeg, never a sink on the encoder above: that one
  // starts on the first watcher and stops on the last, and restarts whole on a
  // tier change — each of which would truncate a file the run is still filling.
  // On the box this is for (a per-run hosted browser for an unattended eval)
  // there is no watcher at all, so this is the only encoder running.
  const recorder = features.includes("record")
    ? createVideoRecorder({
        display: process.env.DISPLAY || ":0",
        width: displayWidth(config),
        height: displayHeight(config),
        dir: config.recordDir,
        maxBytes: config.recordMaxBytes,
      })
    : undefined;
  if (recorder) {
    // Best-effort: a box whose recording dir cannot be created still runs and
    // simply fails the first `start` — refusing to boot a browser over a
    // missing evidence directory would cost the run everything to save a file.
    try {
      mkdirSync(config.recordDir, { recursive: true });
    } catch (error) {
      log(
        `could not create ${config.recordDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
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
    ...(recorder ? { recorder } : {}),
    displaySize: () => ({
      width: displayWidth(config),
      height: displayHeight(config),
    }),
    cssViewport: () => {
      const session = driver.sessionViewportState?.();
      return session
        ? { width: session.width, height: session.height }
        : { ...BROWSERD_OBSERVATION_VIEWPORT };
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
    // The recording BEFORE the encoder and the server, and awaited: it is the
    // only thing here whose value is a file on disk, and ffmpeg needs its
    // SIGINT and a moment to write the last fragment. Bounded (SIGINT, then
    // SIGKILL at the grace) because this is the exit path — waiting forever
    // means the process never leaves and the box is never released.
    await recorder?.finalize({ graceMs: 2_000 }).catch(() => {});
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
