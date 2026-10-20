import type { UIMessageChunk } from "ai";
import {
  SANDBOX_NOTICE_DATA_PART_TYPE,
  type SandboxNoticeReason,
} from "@/shared/sandbox-notice";
import { HISTORY_NOTICE_DATA_PART_TYPE } from "@/shared/history-notice";
import type { ElicitationChunkWriter } from "../routes/web/hosted-elicitation.js";
import { logger } from "./logger.js";

/**
 * A stream writer that can optionally report whether the stream is still open.
 * `isClosed` is implemented by the emulated engine's no-throw `safeWriter`; the
 * other engines pass a writer that throws on a dead controller, which the
 * try/catch handles instead.
 */
export type SandboxNoticeWriter = ElicitationChunkWriter & {
  isClosed?: () => boolean;
};

/**
 * Flush the turn's sandbox notices onto the freshly-ready stream writer, then
 * ACK the ones that actually made it out.
 *
 * The ack is what closes the delivery gap: the control plane keeps a notice
 * pending until this point, so a turn that dies before the writer exists
 * re-delivers it rather than losing it. Only notices actually DELIVERED are
 * acked.
 *
 * "Delivered" cannot be inferred from `write()` returning normally. The
 * emulated engine hands us `safeWriter` (mcpjam-stream-handler.ts), which is
 * deliberately no-throw — it swallows controller failures and silently no-ops
 * once the stream is closed, so that a client disconnect cannot bring down the
 * agentic loop. Trusting a clean return there would let us ack (and therefore
 * permanently consume) a notice the browser never received. So the writer is
 * asked directly via {@link SandboxNoticeWriter.isClosed}, and the abort signal
 * is consulted too.
 *
 * Best-effort per notice in both directions: neither a failed write nor a
 * failed ack may take down a turn whose only problem is that we couldn't
 * narrate the machine. Bailing out early costs a duplicate notice next turn,
 * never a lost one.
 */
export function emitSandboxNotices(
  writer: SandboxNoticeWriter | null | undefined,
  notices: SandboxNoticeReason[] | undefined,
  ack?: (delivered: SandboxNoticeReason[]) => void,
  abortSignal?: AbortSignal,
): void {
  if (!writer || !notices?.length) return;
  const closed = () => writer.isClosed?.() === true || abortSignal?.aborted;
  const delivered: SandboxNoticeReason[] = [];
  for (const reason of notices) {
    if (closed()) break;
    try {
      writer.write({
        type: SANDBOX_NOTICE_DATA_PART_TYPE,
        data: { reason },
        transient: true,
      } satisfies UIMessageChunk);
      // Re-checked AFTER the write: this is the call that may have discovered
      // the stream was gone, and the chunk that discovered it did not land.
      if (closed()) break;
      delivered.push(reason);
    } catch (error) {
      logger.warn("[chat] sandbox notice stream write failed", {
        reason,
        error,
      });
    }
  }
  if (delivered.length > 0) ack?.(delivered);
}

/**
 * Tell the browser that earlier assistant replies in this conversation are
 * not in this turn's model context (MJ-009), so the chat can say so.
 * Best-effort: a failed write costs the notice, never the turn.
 */
export function emitHistoryNotice(
  writer: SandboxNoticeWriter | null | undefined,
  due: boolean,
  chatSessionId: string | undefined,
): void {
  if (!writer || !due) return;
  try {
    writer.write({
      type: HISTORY_NOTICE_DATA_PART_TYPE,
      data: {
        reason: "earlier_replies_not_sent",
        ...(chatSessionId ? { chatSessionId } : {}),
      },
      transient: true,
    } satisfies UIMessageChunk);
  } catch (error) {
    logger.warn("[chat] history notice stream write failed", { error });
  }
}
