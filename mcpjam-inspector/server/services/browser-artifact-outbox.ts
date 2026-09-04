/**
 * browser-artifact-outbox.ts — durable, retryable hand-off of a session's
 * browser-rendered MCP App artifacts to `chatSessions:recordBrowserArtifacts`.
 *
 * The problem it solves: `BrowserSessionContext.drainNewArtifacts()` advances
 * its cursor the moment it is called, so whatever it hands back is gone from the
 * context's "new" window forever. The previous per-turn persister took a drain
 * and, on a transient mutation failure, simply dropped the batch — losing that
 * turn's screenshots with nothing left to retry. And the write races
 * `/ingest-chat`: the mutation legitimately returns `null` until the session row
 * lands, which on turn 0 is routine, not exceptional.
 *
 * So drains land here instead, in two deliberately separate phases:
 *
 *   - `take()` drains the context into memory. Synchronous and cheap — it does
 *     NO network, so a caller can run it while Chromium is still alive without
 *     risking a stalled upload pinning the browser open.
 *   - `flush()` serializes whatever is held (uploading each screenshot to Convex
 *     storage exactly ONCE — a serialized batch is never re-serialized) and then
 *     writes. A batch whose write fails, or returns the retryable `null`, stays
 *     held for the next flush. Retrying is safe: the backend upserts on
 *     `(sessionId, toolCallId)` / `(sessionId, toolCallId, stepIndex)`.
 *
 * Batches are keyed by each artifact's OWN `promptIndex`, not by the turn that
 * happened to drain it: the mutation stamps one batch-level `promptIndex`
 * server-side, so mixing turns in a single call would misattribute artifacts (a
 * late turn-0 screenshot showing up under turn 3).
 *
 * `stageVideo()` uploads the terminal replay `.webm` and holds its blob id; the
 * next flush attaches it — riding an artifact write when there is one left, or
 * as a video-only write when every batch already landed per-turn.
 *
 * Surface-neutral: the caller supplies the Convex identity and, for a hosted
 * scenario, its access pair. A swarm run passes neither, and the mutation
 * authorizes the session owner (the run launcher) instead.
 */

import { ConvexHttpClient } from "convex/browser";
import type {
  BrowserInteractionStepPayload,
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
  WidgetRenderObservationPayload,
} from "@/shared/eval-trace";
import { logger } from "../utils/logger.js";
import { writeUntilAcknowledged } from "../utils/acknowledged-write.js";
import { uploadVideoBlob } from "../utils/mcp-app-widget-capture.js";
import type { BrowserSessionContext } from "./browser-session-context.js";
import {
  serializeBrowserStepsForBackend,
  serializeRenderObservationsForBackend,
  toBrowserStepPayload,
  toObservationPayload,
} from "./browser-artifact-serialization.js";

/** Drained-but-not-yet-uploaded artifacts, screenshots still base64. */
type RawBucket = {
  promptIndex: number;
  observations: RunnerWidgetRenderObservation[];
  steps: RunnerBrowserInteractionStep[];
};

/** Uploaded + sanitized artifacts awaiting a successful write. */
type WireBatch = {
  promptIndex: number;
  observations: WidgetRenderObservationPayload[];
  steps: BrowserInteractionStepPayload[];
};

export interface BrowserArtifactOutbox {
  /**
   * Drain everything the browser context recorded since the last take and hold
   * it. Memory-only and synchronous — safe to call on a terminal path while the
   * browser is still alive. `fallbackPromptIndex` buckets any artifact that
   * somehow arrives without a `promptIndex` of its own.
   */
  take(browser: BrowserSessionContext, fallbackPromptIndex: number): void;
  /**
   * Upload the terminal replay video and hold its blob id for the next flush.
   * Idempotent — a no-op once a video is staged or attached. Never throws.
   */
  stageVideo(bytes: Buffer): Promise<void>;
  /**
   * Serialize anything not yet serialized, then attempt every held batch (and
   * the staged video). Whatever fails stays held. Never throws; returns what
   * happened so a terminal caller can log the residue.
   */
  flush(): Promise<{
    written: number;
    pending: number;
    videoAttached: boolean;
  }>;
  /** Batches still awaiting a successful write (held + not-yet-serialized). */
  readonly pendingBatchCount: number;
}

export function createBrowserArtifactOutbox(args: {
  chatSessionId: string;
  /** Convex bearer for the uploads + the mutation. */
  convexAuthToken: string;
  /** Hosted-scenario auth pair. Omitted ⇒ the direct-session (owner) branch. */
  scenarioId?: string;
  accessVersion?: number;
  /** Log prefix so each surface stays greppable. */
  logScope: string;
}): BrowserArtifactOutbox {
  const { chatSessionId, convexAuthToken, scenarioId, accessVersion, logScope } =
    args;

  // Both keyed by promptIndex so repeat takes for the same turn merge instead of
  // producing two writes that would each restamp the same rows.
  const raw = new Map<number, RawBucket>();
  const wire = new Map<number, WireBatch>();
  let stagedVideoBlobId: string | undefined;
  let videoAttached = false;
  let client: ConvexHttpClient | null = null;
  let clientUnavailable = false;

  /**
   * `CONVEX_URL` is the deployment URL the http client wants (a runner's own
   * `convexHttpUrl` is the `.convex.site` HTTP-actions endpoint). Resolved
   * lazily and remembered: a missing env var is a deployment problem, not a
   * per-call one, so warn once and degrade to "no persistence" instead of
   * spamming every turn.
   */
  const getClient = (): ConvexHttpClient | null => {
    if (client) return client;
    if (clientUnavailable) return null;
    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      clientUnavailable = true;
      logger.warn(
        `[${logScope}] CONVEX_URL not set; browser artifacts will not persist`,
        { chatSessionId },
      );
      return null;
    }
    try {
      const created = new ConvexHttpClient(convexUrl);
      created.setAuth(convexAuthToken);
      client = created;
      return client;
    } catch (err) {
      clientUnavailable = true;
      logger.warn(`[${logScope}] convex client setup failed`, {
        chatSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  const bucketOf = (
    promptIndex: unknown,
    fallbackPromptIndex: number,
  ): number =>
    typeof promptIndex === "number" && Number.isFinite(promptIndex)
      ? promptIndex
      : fallbackPromptIndex;

  const rawBucket = (promptIndex: number): RawBucket => {
    const existing = raw.get(promptIndex);
    if (existing) return existing;
    const created: RawBucket = { promptIndex, observations: [], steps: [] };
    raw.set(promptIndex, created);
    return created;
  };

  const wireBatch = (promptIndex: number): WireBatch => {
    const existing = wire.get(promptIndex);
    if (existing) return existing;
    const created: WireBatch = { promptIndex, observations: [], steps: [] };
    wire.set(promptIndex, created);
    return created;
  };

  /**
   * Upload + sanitize every raw artifact into its wire batch.
   *
   * Isolated PER ARTIFACT, and each one is `shift()`ed off its raw bucket only
   * once it has landed in a wire batch. That's what keeps the module's whole
   * promise intact under a mid-bucket throw: an artifact that was already
   * uploaded moved to `wire` (so it never re-uploads), one that threw is dropped
   * with a warn (so it can't retry-upload forever), and every artifact behind it
   * stays in `raw` for the next flush instead of being lost with the bucket.
   *
   * The per-artifact serializers are themselves fail-soft about the screenshot
   * (a failed upload drops the blob id and KEEPS the row), so a throw here is a
   * systemic failure about one record, not a lost turn.
   */
  const serializePending = async (
    convexClient: ConvexHttpClient,
  ): Promise<void> => {
    for (const bucket of [...raw.values()]) {
      while (bucket.observations.length > 0) {
        const obs = bucket.observations[0]!;
        try {
          const [serialized] = await serializeRenderObservationsForBackend(
            [obs],
            convexClient,
          );
          bucket.observations.shift();
          if (serialized) {
            wireBatch(
              bucketOf(serialized.promptIndex, bucket.promptIndex),
            ).observations.push(toObservationPayload(serialized));
          }
        } catch (err) {
          bucket.observations.shift();
          logger.warn(
            `[${logScope}] dropped one render observation it could not serialize`,
            {
              chatSessionId,
              promptIndex: bucket.promptIndex,
              toolCallId: obs.toolCallId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      while (bucket.steps.length > 0) {
        const step = bucket.steps[0]!;
        try {
          const [serialized] = await serializeBrowserStepsForBackend(
            [step],
            convexClient,
          );
          bucket.steps.shift();
          if (serialized) {
            wireBatch(
              bucketOf(serialized.promptIndex, bucket.promptIndex),
            ).steps.push(toBrowserStepPayload(serialized));
          }
        } catch (err) {
          bucket.steps.shift();
          logger.warn(
            `[${logScope}] dropped one interaction step it could not serialize`,
            {
              chatSessionId,
              promptIndex: bucket.promptIndex,
              toolCallId: step.toolCallId,
              stepIndex: step.stepIndex,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      if (bucket.observations.length === 0 && bucket.steps.length === 0) {
        raw.delete(bucket.promptIndex);
      }
    }
  };

  return {
    get pendingBatchCount() {
      return new Set([...raw.keys(), ...wire.keys()]).size;
    },

    take(browser, fallbackPromptIndex) {
      const { observations, steps } = browser.drainNewArtifacts();
      for (const obs of observations) {
        rawBucket(bucketOf(obs.promptIndex, fallbackPromptIndex)).observations.push(
          obs,
        );
      }
      for (const step of steps) {
        rawBucket(bucketOf(step.promptIndex, fallbackPromptIndex)).steps.push(
          step,
        );
      }
    },

    async stageVideo(bytes) {
      if (videoAttached || stagedVideoBlobId || bytes.length === 0) return;
      const convexClient = getClient();
      if (!convexClient) return;
      try {
        stagedVideoBlobId = await uploadVideoBlob(convexClient, bytes);
        if (stagedVideoBlobId === undefined) {
          // `uploadVideoBlob` also returns undefined WITHOUT throwing — an
          // unusable upload URL, or a response carrying no storageId. Staging
          // happens once per session, so this loss is permanent; say so rather
          // than letting the terminal report a bare `videoAttached: false`.
          logger.warn(
            `[${logScope}] replay video upload returned no storage id; dropping it`,
            { chatSessionId, bytes: bytes.length },
          );
        }
      } catch (err) {
        // Bounded by `uploadVideoBlob` (size + timeout). A dropped video still
        // leaves the screenshots, which the Replay UI renders on their own.
        logger.warn(`[${logScope}] replay video upload failed`, {
          chatSessionId,
          bytes: bytes.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    async flush() {
      const convexClient = getClient();
      if (!convexClient) {
        return {
          written: 0,
          pending: new Set([...raw.keys(), ...wire.keys()]).size,
          videoAttached,
        };
      }


      await serializePending(convexClient);

      const auth = {
        ...(scenarioId !== undefined ? { scenarioId } : {}),
        ...(accessVersion !== undefined ? { accessVersion } : {}),
        chatSessionId,
      };

      let written = 0;
      // Ascending promptIndex, so the staged video (which rides the first
      // successful write below) attaches as early as possible.
      const ordered = [...wire.values()].sort(
        (a, b) => a.promptIndex - b.promptIndex,
      );

      for (const batch of ordered) {
        if (batch.observations.length === 0 && batch.steps.length === 0) {
          wire.delete(batch.promptIndex);
          continue;
        }
        // Ride the staged video along on the first write of this flush — one
        // fewer round trip, and the attach is first-write-wins server-side.
        const carriesVideo = !videoAttached && stagedVideoBlobId !== undefined;
        // ONE attempt per flush, through the shared acknowledgement primitive:
        // the retry cadence here is "the next flush", not a loop inside this
        // one, so a stalled backend never holds a terminal path open. What is
        // shared with the evidence client is the RULE, not the schedule —
        // state is released only on a confirmed acknowledgement.
        const attempt = await writeUntilAcknowledged(
          async () => {
            const result = await convexClient.mutation(
              "chatSessions:recordBrowserArtifacts" as any,
              {
                ...auth,
                promptIndex: batch.promptIndex,
                ...(batch.observations.length
                  ? { widgetRenderObservations: batch.observations }
                  : {}),
                ...(batch.steps.length
                  ? { browserInteractionSteps: batch.steps }
                  : {}),
                ...(carriesVideo ? { videoBlobId: stagedVideoBlobId } : {}),
              },
            );
            // The session row hasn't landed yet (`/ingest-chat` race) — a
            // legitimate `null`, not a failure, and the write is idempotent so
            // the next flush retries it.
            return result == null
              ? { status: "retryable" as const, reason: "session row not ready" }
              : { status: "acknowledged" as const, value: result };
          },
          { maxAttempts: 1 },
        );

        if (!attempt.acknowledged) {
          if (attempt.reason !== "session row not ready") {
            logger.warn(
              `[${logScope}] browser artifact write failed; retrying`,
              {
                chatSessionId,
                promptIndex: batch.promptIndex,
                observations: batch.observations.length,
                steps: batch.steps.length,
                error: attempt.reason,
              },
            );
          }
          continue;
        }

        wire.delete(batch.promptIndex);
        written += 1;
        if (carriesVideo) {
          videoAttached = true;
          stagedVideoBlobId = undefined;
        }
      }

      // A video with no artifacts left to ride on — the common terminal case,
      // where every batch already landed per-turn — goes as a video-only write.
      if (!videoAttached && stagedVideoBlobId !== undefined) {
        try {
          const result = await convexClient.mutation(
            "chatSessions:recordBrowserArtifacts" as any,
            { ...auth, promptIndex: 0, videoBlobId: stagedVideoBlobId },
          );
          if (result != null) {
            videoAttached = true;
            stagedVideoBlobId = undefined;
          }
        } catch (err) {
          logger.warn(`[${logScope}] replay video attach failed`, {
            chatSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // A staged-but-unattached video IS outstanding work — and unlike a batch
      // it can never be retried once the run is over. Counting only `wire.size`
      // let the terminal path report "nothing pending" while silently losing the
      // replay.
      const videoPending = !videoAttached && stagedVideoBlobId !== undefined;
      return {
        written,
        pending: wire.size + (videoPending ? 1 : 0),
        videoAttached,
      };
    },
  };
}
