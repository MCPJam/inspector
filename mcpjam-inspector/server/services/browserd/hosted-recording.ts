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
import { createHash } from "node:crypto";
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

/**
 * The whole start — status probe, then the start call — inside this.
 *
 * `ensureLiveBrowserSession` is on the critical path of the FIRST hosted
 * `browser_*` call of a turn, and `BrowserdClient`'s own timeout is 75s (long
 * on purpose: it backstops a navigation that legitimately takes a minute).
 * Inheriting that here would let an unresponsive recorder endpoint delay the
 * agent's first action by over a minute to decide whether to record it. Five
 * seconds is generous for two small JSON round trips to a box that is already
 * answering, and the failure mode past it is the one this module is built for:
 * no video, and the run proceeds.
 */
export const HOSTED_RECORDING_START_TIMEOUT_MS = 5_000;

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
  /**
   * The daemon boot this take belongs to.
   *
   * A per-run daemon can be relaunched mid-run (the supervisor's recovery
   * path), and the new boot is a new process with no recording and a new
   * bearer. Keyed only by `sandboxRowId`, the registry would treat the stale
   * entry as "already recording", never start a take on the new daemon, and
   * then hand the collector a client pointed at a boot that is gone — a run
   * whose browser work happened entirely after the relaunch would report no
   * video and no reason for it.
   */
  bootId: string;
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
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
  if (safe === sessionId && safe.length > 0 && safe.length <= 64) return safe;
  // IDENTITY SURVIVES THE MANGLING. Both the truncation and the substitution
  // are lossy — `a/b` and `a-b` sanitize to the same string, and two long ids
  // sharing a prefix truncate to the same one — and this id is now load-
  // bearing: the 409 reclaim path treats a matching `recordStatus.id` as proof
  // the daemon's take is OURS. Two runs colliding there would let the second
  // stop and upload the first's recording as its own. The suffix is derived
  // from the FULL original, so distinct sessions stay distinct however the
  // readable part was cut.
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  const head = safe.slice(0, 64 - digest.length - 1);
  return head.length > 0 ? `${head}-${digest}` : `rec-${digest}`;
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
    timeoutMs?: number;
  },
): Promise<void> {
  if (!recordingEnabled()) return;
  const { client, sandboxRowId, sandboxId, sessionId, bootId } = handle;
  // IDEMPOTENT at the registry, before any network. `ensureLiveBrowserSession`
  // is called once per turn by the lazy browser-tool path, so an iteration
  // with ten browser turns would otherwise send ten starts and read nine
  // `record_active` refusals — noise that looks exactly like a real conflict.
  //
  // Keyed by the BOOT as well as the row: a relaunched daemon is a new process
  // with no take on it, and treating the stale entry as "already recording"
  // would leave the rest of the run unrecorded with nothing to say why.
  const existing = active.get(sandboxRowId);
  if (existing?.bootId === bootId) return;
  // Captured rather than re-read inside the closure below: `client.record` is
  // optional on `SessionClient` (a client that only sends commands is still
  // one), and narrowing it here is what lets the take's `stop` hold a
  // reference that cannot have become undefined.
  const record = client.record;
  if (!record) return;
  const now = deps.now ?? Date.now;
  const id = recordingIdFor(sessionId);
  // ABANDONED WHEN THE DEADLINE WINS. `Promise.race` does not cancel the work
  // it lost to — the status probe and the start call keep going — so without
  // this flag a start that finally lands after the deadline would `active.set`
  // a take the caller has already given up on, quite possibly after the
  // collector ran and the box was released. That leaves a registry entry for a
  // machine that no longer exists, and it survives `forgetHostedRecording`
  // because it is written after the delete.
  //
  // Set by the TIMER rather than in the catch below, so there is no window in
  // which the deadline has fired and the flag has not.
  let abandoned = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = deps.timeoutMs ?? HOSTED_RECORDING_START_TIMEOUT_MS;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      abandoned = true;
      reject(new Error(`hosted recording start timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        const status = await client.status();
        if (status.kind !== "ok" || !status.features?.includes("record")) return;
        const started = await record({
          action: "start",
          id,
          fps: HOSTED_RECORDING_FPS,
        });
        if (!started.ok) {
          if (started.status !== 409) {
            logger.info("[browser-session] browser.sandbox_recording_skipped", {
              sandboxRowId,
              status: started.status,
              error: started.error,
            });
            return;
          }
          // 409 SAYS SOMETHING IS RECORDING — NOT THAT IT IS OURS. A daemon
          // reused across iterations can still be holding the PREVIOUS
          // iteration's take. Registering it blind would make the collector
          // stop that take and upload it as this run's video: evidence of the
          // wrong run, which is worse than no evidence, because nothing about
          // it looks wrong. So ask whose it is, and walk away when it is not
          // ours.
          // Matched on the ID, never on `active`. A take that hit its size cap
          // reports `active: false` while KEEPING its id — it is still ours
          // and its file is still on the box, waiting to be collected. Reading
          // "not active" as "somebody else's" would abandon exactly the
          // truncated recording the whole `truncated` flag exists to deliver.
          const state = await client.recordStatus?.();
          if (state?.id !== id) {
            logger.info("[browser-session] browser.sandbox_recording_skipped", {
              sandboxRowId,
              status: 409,
              error: "this daemon is holding a take that is not ours",
              activeId: state?.id,
            });
            return;
          }
          // It IS ours — a racing start from this same run. Fall through and
          // register: the file exists and the collector is the only thing that
          // will ever stop it.
        }
        // Checked immediately before the write, and after every await above:
        // by now the caller may have moved on to release the box.
        //
        // The take itself is deliberately LEFT RUNNING rather than stopped.
        // `id` is a pure function of the session, so the next turn's start
        // meets its own take as a 409, matches the id, and adopts it below —
        // which yields MORE video than restarting would, since the take has
        // been recording since here. Stopping it would throw that away, and on
        // a run whose last browser turn this was, the box is released moments
        // later and ffmpeg goes with it.
        if (abandoned) return;
        active.set(sandboxRowId, {
          sandboxId,
          bootId,
          connect: () => deps.connect(sandboxId),
          stop: () => record({ action: "stop" }),
          fps: HOSTED_RECORDING_FPS,
          startedAtMs: now(),
        });
      })(),
      deadline,
    ]);
  } catch (err) {
    // An unreachable daemon, a status probe past the deadline: the run has no
    // video. It must not have no browser, and it must not WAIT for one.
    logger.info("[browser-session] browser.sandbox_recording_skipped", {
      sandboxRowId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
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
