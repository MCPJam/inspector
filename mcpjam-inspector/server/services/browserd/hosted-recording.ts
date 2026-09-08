/**
 * Video evidence for an unattended run on a per-run hosted browser.
 *
 * THE PROBLEM. A browser eval or a swarm attempt runs on a disposable desktop
 * box with nobody watching — that absence is what the sandbox handle's missing
 * stream says (`SandboxHostedBrowserSessionHandle` has no `streamUrl`). When
 * the run is over the box is released and everything on it is gone, so the
 * only account of what the agent actually saw is the step list. The local
 * widget harness has had a replay video in the trace viewer for a while; this
 * fills the same slot for hosted runs, through the same pipe
 * (`chatSessions.videoBlobId` → `uploadVideoBlob` → trace-viewer playback).
 *
 * WHERE IT SITS. Start rides `ensureLiveBrowserSession`, which the browser
 * tools call LAZILY — so a run that never touches `browser_*` never boots a
 * daemon and never records one. Collection rides the release path, and has to,
 * because the file lives on the box: once `releaseEvalSandbox` returns there is
 * nothing left to read.
 *
 * WHAT MUST NEVER HAPPEN. Evidence must never cost a run its box. Every
 * function here is total: a daemon that has gone away, a read that hangs, an
 * SDK that throws — all of them answer `null` inside a deadline and the caller
 * releases exactly as it would have. That is why `collectHostedRecording…`
 * has no failure mode in its type, and why the registry entry is deleted in a
 * `finally` rather than on the happy path.
 */
import { logger } from "../../utils/logger.js";
import type { BrowserdRecordResult } from "./browserd-client";
import type {
  SandboxHostedBrowserSessionHandle,
  SessionSandbox,
} from "./browser-session";

/**
 * Frames per second for an unattended run.
 *
 * 15, uniformly, with no per-suite setting in v1 — a knob nobody has data to
 * turn yet is a knob that gets set wrong. It reads well for a browser agent
 * (the motion that matters is a page loading and a click landing, not a 60fps
 * animation), and `mpdecimate` means an idle page costs nothing at any rate,
 * so the number is really about how smooth a scroll looks rather than about
 * size. The daemon's API takes `fps` from day one, so a per-suite setting
 * later needs no daemon change.
 */
export const HOSTED_RECORDING_FPS = 15;

/**
 * The whole collect — stop, connect, read, disconnect — inside this.
 *
 * The release path is on a run's critical exit, and a hosted box costs money
 * until it is released. 45s is generous for stopping ffmpeg and reading tens
 * of megabytes over the E2B files API, and it is a bound rather than an
 * expectation: the ordinary case is a few seconds.
 */
export const HOSTED_RECORDING_COLLECT_TIMEOUT_MS = 45_000;

/** What one collected recording carries into the evidence pipe. */
export interface HostedRecording {
  bytes: Buffer;
  /** Always mp4 — the daemon's container. Explicit because the pipe's
   *  default is `video/webm`, and Convex serves back whatever was posted. */
  mime: "video/mp4";
  durationMs: number;
  distinctFrames: number;
  fps: number;
  /** The take stopped at the size cap (or on a crash) before it was asked to. */
  truncated: boolean;
  /**
   * When the daemon said it had started, on the INSPECTOR's clock.
   *
   * Stamped after the start call returns, so it is late by at most one
   * round trip. Good enough to say "this run was recorded from about here",
   * and named as the assumption a future `videoOffsetMs` would rest on.
   */
  startedAtMs: number;
}

/** A take in flight, keyed by the control-plane row that owns the box. */
interface ActiveRecording {
  sandboxId: string;
  connect: () => Promise<SessionSandbox>;
  stop: () => Promise<BrowserdRecordResult>;
  fps: number;
  startedAtMs: number;
}

/**
 * In-process, and that is a deliberate limit rather than an oversight.
 *
 * A recording is only collectable by the replica that started it — the file is
 * on a box that replica has the daemon's bearer for — so a map that outlived
 * the process would describe takes nothing can read. A replica that dies
 * mid-run loses the video and releases nothing; the backend's sandbox GC reaps
 * the box, exactly as it does for every other thing that replica was holding.
 */
const active = new Map<string, ActiveRecording>();

/** The operator's switch, read at CALL time so a redeploy is not needed. */
function recordingEnabled(): boolean {
  return process.env.MCPJAM_HOSTED_BROWSER_RECORDING !== "0";
}

/**
 * The daemon's recording id, which becomes the filename on the box.
 *
 * Derived from the session id and reduced to what the daemon's route accepts
 * (`[A-Za-z0-9_-]{1,64}`) rather than passed through and hoped for: an id the
 * route refuses is a 400 that reads, in a log, exactly like a daemon that
 * cannot record — and the two want different fixes.
 */
export function recordingIdFor(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  return safe.length > 0 ? safe : "recording";
}

/**
 * Start recording an unattended run, if this box can and this deployment wants
 * it.
 *
 * Gated on the daemon ADVERTISING `"record"`, never on a version number: an
 * older daemon is a normal thing to meet mid-rollout (nothing here forces a
 * relaunch), and calling a route it does not serve would turn a missing video
 * into a 404 in the logs of every run.
 *
 * Never throws, and never delays the run: a failure to start means the run has
 * no video, which is strictly better than a run that does not happen.
 */
export async function startHostedRecording(
  handle: SandboxHostedBrowserSessionHandle,
  deps: {
    connect: (sandboxId: string) => Promise<SessionSandbox>;
    now?: () => number;
  },
): Promise<void> {
  if (!recordingEnabled()) return;
  const { client, sandboxRowId, sandboxId, sessionId } = handle;
  // IDEMPOTENT at the registry, before any network. `ensureLiveBrowserSession`
  // is called once per turn by the lazy browser-tool path, so an iteration
  // with ten browser turns would otherwise send ten starts and read nine
  // `record_active` refusals — noise that looks exactly like a real conflict.
  if (active.has(sandboxRowId)) return;
  if (!client.record) return;
  const now = deps.now ?? Date.now;
  try {
    const status = await client.status();
    if (status.kind !== "ok" || !status.features?.includes("record")) return;
    const started = await client.record({
      action: "start",
      id: recordingIdFor(sessionId),
      fps: HOSTED_RECORDING_FPS,
    });
    if (!started.ok) {
      // 409 means this box is already recording — a daemon reused across
      // iterations whose previous take was never collected, or a racing start
      // this process did not make. Registered anyway: the file exists and the
      // collector is the only thing that will ever stop it.
      if (started.status !== 409) {
        logger.info("[browser-session] browser.sandbox_recording_skipped", {
          sandboxRowId,
          status: started.status,
          error: started.error,
        });
        return;
      }
    }
    active.set(sandboxRowId, {
      sandboxId,
      connect: () => deps.connect(sandboxId),
      stop: () => client.record!({ action: "stop" }),
      fps: HOSTED_RECORDING_FPS,
      startedAtMs: now(),
    });
  } catch (err) {
    // An unreachable daemon, a timed-out status probe: the run has no video.
    // It must not have no browser.
    logger.info("[browser-session] browser.sandbox_recording_skipped", {
      sandboxRowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Stop the take and read the file off the box, BEFORE it is released.
 *
 * `null` for every way this can fail to produce bytes, including "nothing was
 * recording" — which is the ordinary answer for a run that never touched a
 * browser, and costs no network at all. The registry entry is dropped whatever
 * happens, so a second call (a `finally` that runs after an early return
 * already collected) is a cheap no-op rather than a second stop against a box
 * that may no longer exist.
 *
 * NEVER THROWS AND NEVER OUTLASTS THE DEADLINE. The caller is a release path:
 * whatever this does, the box gets released.
 */
export async function collectHostedRecordingBeforeRelease(
  sandboxRowId: string,
  options: { timeoutMs?: number } = {},
): Promise<HostedRecording | null> {
  const entry = active.get(sandboxRowId);
  // A registry MISS is the common case (a run with no browser, or a second
  // call), and it answers without touching the network.
  if (!entry) return null;
  active.delete(sandboxRowId);

  const timeoutMs = options.timeoutMs ?? HOSTED_RECORDING_COLLECT_TIMEOUT_MS;
  const startedAt = Date.now();
  try {
    return await withDeadline(collect(entry), timeoutMs);
  } catch (err) {
    // Every failure lands here and every one of them means the same thing to
    // the caller: no video, release the box. Logged at info because a run
    // without evidence is a degraded run, not a broken one.
    logger.info("[browser-session] browser.sandbox_recording_collected", {
      sandboxRowId,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function collect(entry: ActiveRecording): Promise<HostedRecording | null> {
  const startedAt = Date.now();
  const stopped = await entry.stop();
  // `recording` is absent on a `start` answer and null when nothing was
  // recording; both mean the same here — there is no file to read.
  if (!stopped.ok || !stopped.recording) return null;
  const { path, bytes, durationMs, distinctFrames, truncated } =
    stopped.recording;
  // A take that wrote nothing (ffmpeg died before its first fragment, or the
  // display never came up). Dropped rather than uploaded: a zero-byte video in
  // the trace viewer is a broken player, which reads as a bug in the product
  // rather than as a run that produced no picture.
  if (bytes <= 0) return null;

  const sandbox = await entry.connect();
  let raw: Uint8Array;
  try {
    if (!sandbox.readBinaryFile) {
      throw new Error("sandbox adapter cannot read binary files");
    }
    raw = await sandbox.readBinaryFile(path);
  } finally {
    // The connection, not the box. `disconnect` never kills the sandbox — the
    // caller's release does that a moment later.
    await sandbox.disconnect().catch(() => {});
  }

  logger.info("[browser-session] browser.sandbox_recording_collected", {
    ok: true,
    bytes: raw.byteLength,
    durationMs,
    distinctFrames,
    truncated,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    bytes: Buffer.from(raw),
    mime: "video/mp4",
    durationMs,
    distinctFrames,
    fps: entry.fps,
    truncated,
    startedAtMs: entry.startedAtMs,
  };
}

/**
 * Forget a take without stopping or reading it.
 *
 * For a box that has already gone (a relaunch reaped the daemon, a provision
 * failed after the start landed): the registry entry would otherwise describe
 * a file nothing can reach, and the next collect would spend its whole
 * deadline discovering that.
 */
export function forgetHostedRecording(sandboxRowId: string): void {
  active.delete(sandboxRowId);
}

/** Test seam: nothing in production drops every take at once. */
export function __resetHostedRecordings(): void {
  active.clear();
}

/**
 * Bound a promise that may never settle.
 *
 * `Promise.race` rather than an abort signal because there is nothing to
 * abort: the E2B files API takes no signal on this path, and a read that hangs
 * hangs. What matters is that the CALLER stops waiting — the orphaned read
 * finishes into a void and the box is released on schedule.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`hosted recording collect timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
