// Phase-4 PR2 (plan: please-do-a-sequential-fail-fast-verdict.md).
//
// Production `StepExecutorHandlers` for the LOCAL (BYOK / AI-SDK) path. These are
// THIN adapters over the existing `driveLocalEvalTurn` — the reuse-gate: no new
// runner, no low-level driver bypass. `driveLocalEvalTurn` MUTATES a rich
// `LocalEvalTurnAcc` in place; the executor's handler contract instead RETURNS a
// `StepEngineOutcome`. So the bridge snapshots the acc before the call and reports
// the per-step DELTA (new messages, this turn's tool calls / errors, usage delta,
// any fatal error). The acc remains the source for trace spans + pinned tool
// errors that the verdict reads alongside the executor's bucketed state.

import {
  driveLocalEvalTurn,
  type DriveLocalEvalTurnParams,
  type LocalEvalTurnAcc,
  type LocalEvalTurnSinks,
} from "./drive-local-eval-turn";
import {
  driveHostedEvalTurn,
  type DriveHostedEvalTurnParams,
} from "./drive-hosted-eval-turn";
import type { PinnedToolCall, PromptTurn, ToolCallStep } from "@/shared/steps";
import {
  extractToolErrors,
  type ToolErrorRecord,
} from "@/shared/eval-matching";
import { buildPinnedTurnAccounting, runPinnedTurn } from "./pinned-turn";
import type { PinnedTurnSsePayload } from "./pinned-turn-sse";
import type {
  StepEngineOutcome,
  StepExecutorHandlers,
} from "./step-executor";

/**
 * Everything `driveLocalEvalTurn` needs except the per-step `promptIndex`/
 * `promptTurn`. The per-turn streaming sinks are built lazily by `buildSinks`
 * (the SSE play-by-play closes over the turn index), not passed statically.
 */
export type LocalStepHandlerContext = Omit<
  DriveLocalEvalTurnParams,
  "promptIndex" | "promptTurn" | "sinks"
> & {
  buildSinks?: (turnOrdinal: number, prompt: string) => LocalEvalTurnSinks;
};

/**
 * Build `onPrompt`/`onToolCall` for the local path. A single shared `acc`
 * (`ctx.acc`) accumulates across steps exactly as the legacy turn loop's `acc`
 * does; each handler reports only what its step added.
 */
export function buildLocalStepHandlers(
  ctx: LocalStepHandlerContext,
): StepExecutorHandlers {
  const { buildSinks, ...driverParams } = ctx;
  const acc: LocalEvalTurnAcc = ctx.acc;

  async function drive(
    promptTurn: PromptTurn,
    turnOrdinal: number,
  ): Promise<StepEngineOutcome> {
    const messagesBefore = acc.conversationMessages.length;
    const inBefore = acc.accumulatedUsage.inputTokens ?? 0;
    const outBefore = acc.accumulatedUsage.outputTokens ?? 0;
    const totalBefore = acc.accumulatedUsage.totalTokens ?? 0;
    const errorBefore = acc.iterationError;

    await driveLocalEvalTurn({
      ...driverParams,
      promptIndex: turnOrdinal,
      promptTurn,
      acc,
      sinks: buildSinks?.(turnOrdinal, promptTurn.prompt),
    });

    // Delta the acc mutated into a return-style outcome.
    const messages = acc.conversationMessages.slice(messagesBefore);
    const toolCalls = acc.toolsCalledByPrompt[turnOrdinal] ?? [];
    const toolErrors = acc.toolErrorsByPrompt[turnOrdinal] ?? [];
    const usage = {
      inputTokens: (acc.accumulatedUsage.inputTokens ?? 0) - inBefore,
      outputTokens: (acc.accumulatedUsage.outputTokens ?? 0) - outBefore,
      totalTokens: (acc.accumulatedUsage.totalTokens ?? 0) - totalBefore,
    };
    // A fatal error newly set by THIS step (the loop stops; the verdict reads it).
    const newError =
      acc.iterationError && acc.iterationError !== errorBefore
        ? acc.iterationError
        : undefined;

    return {
      ...(messages.length ? { messages } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolErrors.length ? { toolErrors } : {}),
      usage,
      ...(newError
        ? {
            iterationError: newError,
            ...(acc.iterationErrorDetails
              ? { iterationErrorDetails: acc.iterationErrorDetails }
              : {}),
            setupFailure: acc.pinnedSetupFailure,
          }
        : {}),
    };
  }

  // R2: drive a model turn (prompt or widget `ui/message` follow-up) and return
  // the delta derived from THIS turn's new messages + spans — NOT the
  // `acc.toolsCalledByPrompt[turnOrdinal]` / `acc.toolErrorsByPrompt[turnOrdinal]`
  // indices, which for a follow-up sharing the parent's turn ordinal hold the
  // PARENT turn's data (the silent mis-grade trap). Capturing the span delta also
  // surfaces `toolErrors` for follow-up turns (the gap `driveFollowUp` had).
  // NOTE: `onPrompt` migrates onto this in R3, once the hosted recursion is gone
  // and a prompt turn's message slice is unambiguous; the pinned `toolCall` path
  // stays on `drive()` (model-free, different delta source).
  async function driveTurn(
    promptTurn: PromptTurn,
    turnOrdinal: number,
  ): Promise<StepEngineOutcome> {
    const messagesBefore = acc.conversationMessages.length;
    const spansBefore = acc.capturedSpans.length;
    const inBefore = acc.accumulatedUsage.inputTokens ?? 0;
    const outBefore = acc.accumulatedUsage.outputTokens ?? 0;
    const totalBefore = acc.accumulatedUsage.totalTokens ?? 0;
    const errorBefore = acc.iterationError;

    await driveLocalEvalTurn({
      ...driverParams,
      promptIndex: turnOrdinal,
      promptTurn,
      acc,
      sinks: buildSinks?.(turnOrdinal, promptTurn.prompt),
    });

    const messages = acc.conversationMessages.slice(messagesBefore);
    const spans = acc.capturedSpans.slice(spansBefore);
    const toolCalls = driverParams.extractToolCalls({ messages });
    const toolErrors = extractToolErrors({
      spans,
      messages: messages as Array<{ role: string; content: unknown }>,
    });
    const usage = {
      inputTokens: (acc.accumulatedUsage.inputTokens ?? 0) - inBefore,
      outputTokens: (acc.accumulatedUsage.outputTokens ?? 0) - outBefore,
      totalTokens: (acc.accumulatedUsage.totalTokens ?? 0) - totalBefore,
    };
    const newError =
      acc.iterationError && acc.iterationError !== errorBefore
        ? acc.iterationError
        : undefined;
    return {
      ...(messages.length ? { messages } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolErrors.length ? { toolErrors } : {}),
      usage,
      ...(newError
        ? {
            iterationError: newError,
            ...(acc.iterationErrorDetails
              ? { iterationErrorDetails: acc.iterationErrorDetails }
              : {}),
            setupFailure: acc.pinnedSetupFailure,
          }
        : {}),
    };
  }

  return {
    onPrompt: ({ step, turnOrdinal }) =>
      drive(
        { id: step.id, prompt: step.prompt, expectedToolCalls: [] },
        turnOrdinal,
      ),
    onToolCall: ({ step, turnOrdinal }) =>
      drive(
        {
          id: step.id,
          prompt: "",
          expectedToolCalls: [],
          pinnedToolCall: {
            serverName: step.serverName,
            toolName: step.toolName,
            arguments: step.arguments,
          },
        },
        turnOrdinal,
      ),
    onFollowUp: ({ text, turnOrdinal }) =>
      driveTurn(
        { id: `followup-${turnOrdinal}`, prompt: text, expectedToolCalls: [] },
        turnOrdinal,
      ),
  };
}

/** Everything `driveHostedEvalTurn` needs except the per-turn `promptIndex`/`prompt`/`widgetChecks`. */
export type HostedStepHandlerContext = Omit<
  DriveHostedEvalTurnParams,
  "promptIndex" | "prompt" | "widgetChecks"
> & {
  /** Mirrors `DriveLocalEvalTurnParams.resolvePinnedServerKey`: resolve a pinned
   *  server ref to a connected manager key (`undefined` ⇒ not-connected setup
   *  failure). */
  resolvePinnedServerKey: (pinned: PinnedToolCall) => string | undefined;
  /** Iteration-level pinned tool failures, kept OFF the driver acc so
   *  `driveHostedEvalTurn` stays pinned-agnostic. The runner threads this into
   *  the verdict's `failOnToolError` gate (the hosted analogue of
   *  `LocalEvalTurnAcc.pinnedToolErrors`). */
  pinnedToolErrors: ToolErrorRecord[];
  /** Streaming only: the shared pinned SSE synthesis (absent ⇒ batch, headless). */
  emitPinnedTurn?: (payload: PinnedTurnSsePayload) => void;
};

/**
 * Production `StepExecutorHandlers` for the HOSTED (MCPJam / org cloud) path — the
 * hosted analogue of {@link buildLocalStepHandlers}. `driveHostedEvalTurn` also
 * mutates a shared `acc` (`{messageHistory, capturedSpans, accumulatedUsage,
 * toolsCalledByPrompt}`) and returns a `completed`/`cancelled`/`failed` outcome;
 * the bridge reports the per-step delta. Pinned (`toolCall`) steps never touch
 * the backend: `runPinnedTurn` is model-free, so `onToolCall` executes it
 * inspector-side and injects the resulting plain-text message pair into
 * `messageHistory` for the next model turn to carry through `/stream`.
 */
export function buildHostedStepHandlers(
  ctx: HostedStepHandlerContext,
): StepExecutorHandlers {
  const acc = ctx.acc;

  async function drivePrompt(
    prompt: string,
    turnOrdinal: number,
  ): Promise<StepEngineOutcome> {
    const messagesBefore = acc.messageHistory.length;
    const inBefore = acc.accumulatedUsage.inputTokens ?? 0;
    const outBefore = acc.accumulatedUsage.outputTokens ?? 0;
    const totalBefore = acc.accumulatedUsage.totalTokens ?? 0;

    const outcome = await driveHostedEvalTurn({
      ...ctx,
      promptIndex: turnOrdinal,
      prompt,
      acc,
    });

    const messages = acc.messageHistory.slice(messagesBefore);
    const toolCalls = acc.toolsCalledByPrompt[turnOrdinal] ?? [];
    const usage = {
      inputTokens: (acc.accumulatedUsage.inputTokens ?? 0) - inBefore,
      outputTokens: (acc.accumulatedUsage.outputTokens ?? 0) - outBefore,
      totalTokens: (acc.accumulatedUsage.totalTokens ?? 0) - totalBefore,
    };

    return {
      ...(messages.length ? { messages } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      usage,
      ...(outcome.kind === "failed"
        ? {
            iterationError: outcome.iterationError,
            ...(outcome.iterationErrorDetails
              ? { iterationErrorDetails: outcome.iterationErrorDetails }
              : {}),
          }
        : {}),
    };
  }

  // R2: drive a model turn (prompt or widget `ui/message` follow-up) and return
  // the delta derived from THIS turn's new messages + spans, NOT
  // `acc.toolsCalledByPrompt[turnOrdinal]` (the shared-turn mis-grade trap). The
  // span delta surfaces `toolErrors`. `driveHostedEvalTurn` no longer self-recurses
  // for follow-ups (R3 deleted that); the executor owns the bounded drain-loop.
  async function driveTurn(
    prompt: string,
    turnOrdinal: number,
  ): Promise<StepEngineOutcome> {
    const messagesBefore = acc.messageHistory.length;
    const spansBefore = acc.capturedSpans.length;
    const inBefore = acc.accumulatedUsage.inputTokens ?? 0;
    const outBefore = acc.accumulatedUsage.outputTokens ?? 0;
    const totalBefore = acc.accumulatedUsage.totalTokens ?? 0;

    const outcome = await driveHostedEvalTurn({
      ...ctx,
      promptIndex: turnOrdinal,
      prompt,
      widgetChecks: [],
    });

    const messages = acc.messageHistory.slice(messagesBefore);
    const spans = acc.capturedSpans.slice(spansBefore);
    const toolCalls = ctx.extractToolCalls(messages);
    const toolErrors = extractToolErrors({
      spans,
      messages: messages as Array<{ role: string; content: unknown }>,
    });
    const usage = {
      inputTokens: (acc.accumulatedUsage.inputTokens ?? 0) - inBefore,
      outputTokens: (acc.accumulatedUsage.outputTokens ?? 0) - outBefore,
      totalTokens: (acc.accumulatedUsage.totalTokens ?? 0) - totalBefore,
    };
    return {
      ...(messages.length ? { messages } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolErrors.length ? { toolErrors } : {}),
      usage,
      ...(outcome.kind === "failed"
        ? {
            iterationError: outcome.iterationError,
            ...(outcome.iterationErrorDetails
              ? { iterationErrorDetails: outcome.iterationErrorDetails }
              : {}),
          }
        : {}),
    };
  }

  // Model-free pinned turn, executed inspector-side (mirrors the local pinned
  // branch in driveLocalEvalTurn). The whole body is caught: local is shielded
  // by runLocalIteration's broad iteration catch, but nothing wraps
  // executeSteps on the hosted path — a throw from `dismissCarriedWidget` /
  // `renderPinnedToolResult` would otherwise escape persistence entirely.
  async function drivePinned(
    step: ToolCallStep,
    turnOrdinal: number,
  ): Promise<StepEngineOutcome> {
    const pinned: PinnedToolCall = {
      serverName: step.serverName,
      toolName: step.toolName,
      arguments: step.arguments,
    };
    try {
      // Mirror the local pinned branch's pre-steps; the executor already
      // stamped `setActivePromptIndex(turnOrdinal)` before dispatching here.
      ctx.browser.setActiveWidgetChecks([]);
      await ctx.browser.dismissCarriedWidget();
      const result = await runPinnedTurn({
        pinned,
        resolvedServerKey: ctx.resolvePinnedServerKey(pinned),
        mcpClientManager: ctx.mcpClientManager,
        browser: ctx.browser,
        promptIndex: turnOrdinal,
      });
      const accounting = buildPinnedTurnAccounting(pinned, result);
      // messageHistory invariant: append only a COMPLETE plain-TEXT
      // user+assistant pair. The next driveHostedEvalTurn snapshots the full
      // history as `/stream` input; text-only messages round-trip the backend
      // untouched — tool-call parts would NOT.
      acc.messageHistory.push(
        accounting.userMessage,
        accounting.assistantMessage,
      );
      (acc.toolsCalledByPrompt[turnOrdinal] ??= []).push(
        ...accounting.toolCalls,
      );
      ctx.pinnedToolErrors.push(...accounting.toolErrors);
      ctx.emitPinnedTurn?.({
        turnIndex: turnOrdinal,
        prompt: accounting.prompt,
        messages: acc.messageHistory,
        spans: acc.capturedSpans,
        usage: acc.accumulatedUsage,
        ...(result.toolCall ? { toolCall: result.toolCall } : {}),
        ...(result.toolCallId ? { toolCallId: result.toolCallId } : {}),
        ...("toolResult" in result ? { toolResult: result.toolResult } : {}),
        ...(result.toolResultIsError
          ? { toolResultIsError: result.toolResultIsError }
          : {}),
        ...(result.toolError ? { toolError: result.toolError } : {}),
        ...(result.iterationError
          ? { iterationError: result.iterationError }
          : {}),
      });
      return {
        messages: [accounting.userMessage, accounting.assistantMessage],
        ...(accounting.toolCalls.length
          ? { toolCalls: accounting.toolCalls }
          : {}),
        ...(accounting.toolErrors.length
          ? { toolErrors: accounting.toolErrors }
          : {}),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        ...(accounting.iterationError
          ? { iterationError: accounting.iterationError, setupFailure: true }
          : {}),
      };
    } catch (error) {
      // Not a setup failure (that flag means "pinned server not connected");
      // a failed outcome halts the executor, records the remaining steps as
      // skipped, and lets the iteration persist with the error.
      const message = error instanceof Error ? error.message : String(error);
      return {
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        iterationError: `pinned tool call "${step.toolName}" failed: ${message}`,
      };
    }
  }

  return {
    onPrompt: ({ step, turnOrdinal }) =>
      drivePrompt(step.prompt, turnOrdinal),
    onToolCall: ({ step, turnOrdinal }) => drivePinned(step, turnOrdinal),
    onFollowUp: ({ text, turnOrdinal }) => driveTurn(text, turnOrdinal),
  };
}
