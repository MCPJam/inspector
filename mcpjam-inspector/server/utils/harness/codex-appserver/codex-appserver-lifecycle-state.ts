/**
 * The adapter-specific `data` on a lifecycle payload.
 *
 * Everything here is what a FUTURE process needs to pick this session back up.
 * Framework-owned continuation state (pending approvals, pending tool results,
 * turn settings) is deliberately absent: the framework persists that itself,
 * and a second copy would be the one that goes stale.
 */
import { z } from "zod/v4";

/**
 * Coordinates of a bridge that is still running.
 *
 * `sandboxId` is read defensively by the inspector's own session-state module
 * (`harness-session-state.ts` reaches into `resumeState.data.bridge.sandboxId`
 * to notice a replaced box), so the shape has to match the codex exec adapter's
 * exactly — a rename here silently degrades that check to its legacy path.
 */
export const codexAppServerBridgeCoordsSchema = z.object({
  port: z.number(),
  token: z.string(),
  lastSeenEventId: z.number(),
  sandboxId: z.string().optional(),
});

export const codexAppServerResumeStateSchema = z.object({
  /** What `thread/resume` needs. */
  threadId: z.string().optional(),
  /** Configuration that a resumed thread would not pick up; a change forces a
   *  fresh thread rather than a silently stale one. */
  turnConfigurationFingerprint: z.string().optional(),
  /** Present on detach/suspend payloads, absent on stop. */
  bridge: codexAppServerBridgeCoordsSchema.optional(),
  /** Placeholder credential environment, so a reattached session reproduces
   *  the environment its bridge already holds. */
  sandboxCredentialEnvironment: z.record(z.string(), z.string()).optional(),
});

export type CodexAppServerResumeState = z.infer<
  typeof codexAppServerResumeStateSchema
>;
