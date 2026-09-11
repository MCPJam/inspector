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
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { displayGeometryFor, resizeHostedDisplay } from "./display-resize";
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
import {
  exportBrowserProfileArchive,
  importBrowserProfileArchive,
} from "../profile-archive";

function log(message: string): void {
  process.stderr.write(`[mcpjam-browserd] ${message}\n`);
}

/**
 * Run one command on the box this daemon is inside.
 *
 * The daemon runs IN the sandbox, so `xrandr` is a local process rather than
 * something to ask the inspector to run remotely — which is the whole reason
 * the resize can be one coordinated transition instead of a round trip per
 * step.
 */
function runShell(
  command: string,
): Promise<{ exitCode: number; stderr?: string }> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { timeout: 10_000 },
      (error, _stdout, stderr) => {
        resolve({
          exitCode: error ? (error as { code?: number }).code ?? 1 : 0,
          stderr: typeof stderr === "string" ? stderr : undefined,
        });
      },
    );
  });
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
  return Math.round(
    BROWSERD_OBSERVATION_VIEWPORT.width * config.deviceScaleFactor,
  );
}

function displayHeight(config: { deviceScaleFactor: number }): number {
  return Math.round(
    BROWSERD_OBSERVATION_VIEWPORT.height * config.deviceScaleFactor,
  );
}

async function main(): Promise<void> {
  const config = readBrowserdConfig();
  const bundleHash = readBundleHash();
  if (config.profileArchivePath && config.contextMode === "persistent") {
    const archive = await readFile(config.profileArchivePath);
    await importBrowserProfileArchive(
      config.userDataDir,
      new Uint8Array(archive),
    );
    await unlink(config.profileArchivePath).catch(() => {});
  }
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
  /**
   * The video encoder, once it exists, so a resize can restart it.
   *
   * Late-bound because the ordering is circular: the encoder needs the display
   * geometry the driver publishes, and the driver needs a way to restart the
   * encoder when that geometry moves.
   */
  let encoder: ReturnType<typeof createVideoEncoder> | undefined;
  // Old Xvfb images remain fixed. New/prelaunched TigerVNC sessions negotiate
  // responsiveness when the enabled pane first reports its size.
  const canResize =
    config.contextMode === "persistent" &&
    config.kiosk &&
    (
      await runShell(
        `xrandr --display ${
          process.env.DISPLAY || ":0"
        } --current | awk '$1 == "VNC-0" { found = 1 } END { exit !found }'`,
      )
    ).exitCode === 0;
  const driver = new ChromiumDriver(context, {
    lease,
    viewport: {
      /**
       * The DAEMON's default is `fixed`, and the door widens it.
       *
       * Every existing opener — an eval, a swarm, a CLI run, an SDK consumer —
       * gets exactly the 1024x768 session it has always had, and only a caller
       * that negotiated a responsive one moves off it. A daemon that defaulted
       * the other way would silently change the size of every recorded eval
       * the first time somebody dragged a panel.
       */
      policy: config.viewportPolicy,
      allowPaneResize: canResize,
      // KIOSK IS THE TEST for "does this box have a display of its own". It is
      // the switch that makes "the display IS the page" true for the encoder,
      // and it is set only on the hosted image; a local Chromium's page is a
      // window, and resizing it is the whole job.
      ...(config.kiosk
        ? {
            resizeDisplay: async (next, previous) => {
              const outcome = await resizeHostedDisplay(
                {
                  display: process.env.DISPLAY || ":0",
                  run: runShell,
                  deviceScaleFactor: config.deviceScaleFactor,
                  restartEncoder: async (size) => {
                    // A fresh codec configuration and a keyframe: an H.264
                    // stream whose SPS says 1024 wide cannot carry a 1400-wide
                    // frame, and a decoder handed one drops it or renders
                    // garbage.
                    //
                    // THE SAME HELPER THE DISPLAY WAS SIZED WITH. A plain
                    // `Math.round` here rounds an odd scaled dimension DOWN
                    // where `displayGeometryFor` rounds it up to even, so
                    // `x11grab` would be given a `-video_size` one column
                    // short of the screen — which captures a corner of the
                    // display and says nothing about it.
                    const { width, height } = displayGeometryFor(size, {
                      deviceScaleFactor: config.deviceScaleFactor,
                    });
                    await encoder?.resize?.({ width, height });
                  },
                },
                next,
                previous,
              );
              if (!outcome.ok) {
                log(
                  `display resize failed (${outcome.reason}); ` +
                    `${outcome.restored ? "restored" : "COULD NOT RESTORE"} ` +
                    `${previous.width}x${previous.height}`,
                );
              }
              return outcome.ok;
            },
          }
        : {}),
    },
  });
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
  encoder = video;
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
  /**
   * The display's geometry right now, derived from the session viewport.
   *
   * A function rather than a constant because on a `followPane` session the
   * answer changes, and every consumer of it — the frame stream's coordinate
   * scale above all — is documented as needing the current one.
   */
  const liveDisplaySize = (): { width: number; height: number } => {
    const session = driver.sessionViewportState?.();
    const css = session
      ? { width: session.width, height: session.height }
      : { ...BROWSERD_OBSERVATION_VIEWPORT };
    const { width, height } = displayGeometryFor(css, {
      deviceScaleFactor: config.deviceScaleFactor,
    });
    return { width, height };
  };

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
    ...(config.contextMode === "persistent"
      ? {
          profileExport: async () => {
            // Closing Chromium flushes cookies/LevelDB before the archive is read.
            // The handler holds the export lease until the bytes are complete.
            await context.close();
            await driver.close();
            return exportBrowserProfileArchive(config.userDataDir);
          },
        }
      : {}),
    // THE DISPLAY AS IT IS NOW, not as it booted.
    //
    // `cssViewport` below already follows the session, and these two are one
    // contract: the frame stream divides them to get the scale a watcher maps
    // its clicks through. A `displaySize` pinned to the boot geometry made the
    // two diverge at precisely the moment something moved, so every click after
    // a resize was scaled by a ratio built from one live number and one stale
    // one.
    //
    // Through `displayGeometryFor`, which is what `xrandr --fb` was actually
    // given — parity bump included. Multiplying by the scale factor a second
    // time here would be off by a pixel on every odd dimension.
    displaySize: liveDisplaySize,
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
