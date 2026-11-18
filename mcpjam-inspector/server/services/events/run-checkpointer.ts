/**
 * The durable state of one event run (C6): checkpoints the backend holds, so
 * a worker that dies mid-turn resumes from the last one, and no tool with an
 * effect runs before a checkpoint names it.
 */

import type { ModelMessage } from "ai";
import { toolCallIdsIn, type EventRunToolIntent } from "./tool-journal.js";

export interface RunCheckpointer {
  /** A real conversation state (resume, a hosted step, the end of the turn). */
  checkpoint(messages: ModelMessage[], step: number): Promise<void>;
  /** Resolves once a written checkpoint names `intent.toolCallId`. */
  ensureDurable(intent: EventRunToolIntent): Promise<void>;
  /** Rewrites the current state (lease renewal). */
  heartbeat(): Promise<void>;
}

/**
 * The run's durable state, written through ONE queue so no write lands behind
 * an older one: a heartbeat can never overwrite a newer intent.
 *
 * `base` is the last real conversation; `intents` are tool calls made since
 * that `base` does not hold yet (the direct engine has no per-step hook).
 * The stored checkpoint is `base` plus one assistant message naming those
 * calls, so a run resumed after a crash finds them unresolved and finishes
 * them through the journal: a completed one replays its recorded result, an
 * unfinished one parks the run. Neither repeats the effect.
 */
export function createRunCheckpointer(args: {
  write: (state: { messages: ModelMessage[]; step: number }) => Promise<void>;
  messages: ModelMessage[];
  step: number;
  /** True when `messages` is already what the backend holds (a resume). */
  stored: boolean;
}): RunCheckpointer {
  let base = args.messages;
  let step = args.step;
  let intents: EventRunToolIntent[] = [];
  let written = args.stored ? toolCallIdsIn(base) : new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  const state = () => ({
    messages:
      intents.length === 0
        ? base
        : [
            ...base,
            {
              role: "assistant",
              content: intents.map((intent) => ({
                type: "tool-call",
                toolCallId: intent.toolCallId,
                toolName: intent.toolName,
                input: intent.input,
              })),
            } as ModelMessage,
          ],
    step,
  });

  const enqueue = (change?: () => void): Promise<void> => {
    const run = queue.then(async () => {
      change?.();
      const next = state();
      await args.write(next);
      written = toolCallIdsIn(next.messages);
    });
    queue = (async () => {
      try {
        await run;
      } catch {
        // `run` hands this write's error to its caller; the queue only orders
        // writes, so a failed one must not block the next.
      }
    })();
    return run;
  };

  return {
    checkpoint(messages, nextStep) {
      return enqueue(() => {
        base = messages;
        step = Math.max(step, nextStep);
        const held = toolCallIdsIn(messages);
        intents = intents.filter((intent) => !held.has(intent.toolCallId));
      });
    },
    async ensureDurable(intent) {
      if (written.has(intent.toolCallId)) return;
      await enqueue(() => {
        const held = toolCallIdsIn(base);
        if (
          !held.has(intent.toolCallId) &&
          !intents.some((known) => known.toolCallId === intent.toolCallId)
        )
          intents = [...intents, intent];
      });
    },
    heartbeat: () => enqueue(),
  };
}
