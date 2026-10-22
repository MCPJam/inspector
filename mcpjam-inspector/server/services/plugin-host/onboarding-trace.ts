import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, MiddlewareHandler } from "hono";
import {
  readPluginOnboardingIntent,
  type PluginOnboardingIntent,
} from "../../../shared/plugin-onboarding.js";
import { PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE } from "../../../shared/plugin-server-unavailable.js";
import type { RequestEventMap } from "../../utils/log-events.js";
import { logger } from "../../utils/logger.js";
import { getRequestLogger } from "../../utils/request-logger.js";

/**
 * Where one plugin onboarding turn got to, in the order a turn reaches them:
 * - `admission`: its environment, with the plugin, resolved for this turn.
 * - `authorization`: its servers authorized and their connections built.
 * - `connection`: connecting and listing tools began.
 * - `tools`: tools listed. A plugin server that failed is left out.
 * - `model`: the model's first step began.
 * - `first_output`: the first text, reasoning or tool call.
 * - `terminal`: the turn finished, failed or was cancelled.
 */
export type OnboardingTurnPhase =
  | "admission"
  | "authorization"
  | "connection"
  | "tools"
  | "model"
  | "first_output"
  | "terminal";

/** How long a turn runs before its watchdog records where it stopped. */
export const ONBOARDING_TURN_WATCHDOG_MS = 60_000;

type TurnLog = {
  turn: (payload: RequestEventMap["plugin.onboarding.turn"]) => void;
  stalled: (payload: RequestEventMap["plugin.onboarding.turn.stalled"]) => void;
};

/**
 * One onboarding attempt's phases, logged once at its terminal result. If
 * the attempt has not finished when the watchdog fires, the phase it stopped
 * at is logged then, under the same attempt id, so a later retry can never
 * stand in for it. Data only: it never changes the turn.
 */
export class OnboardingTurnTrace {
  private readonly startedAt = performance.now();
  private readonly phases: Partial<Record<OnboardingTurnPhase, number>> = {};
  private lastPhase: OnboardingTurnPhase | "received" = "received";
  private unavailableServers = 0;
  private finished = false;
  private readonly watchdog: ReturnType<typeof setTimeout>;

  constructor(
    readonly intent: PluginOnboardingIntent,
    private readonly log: TurnLog,
    watchdogMs = ONBOARDING_TURN_WATCHDOG_MS,
  ) {
    this.watchdog = setTimeout(() => this.stalled(), watchdogMs);
    this.watchdog.unref?.();
  }

  private elapsed(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  /** The first time a phase is reached. A repeat changes nothing. */
  mark(phase: Exclude<OnboardingTurnPhase, "terminal">): void {
    if (this.finished || this.phases[phase] !== undefined) return;
    this.phases[phase] = this.elapsed();
    this.lastPhase = phase;
  }

  countUnavailable(servers: number): void {
    this.unavailableServers += servers;
  }

  /** The terminal result: logged once, and the watchdog stops. */
  finish(
    outcome: "success" | "error" | "cancelled",
    statusCode: number,
    code?: string,
  ): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.watchdog);
    this.phases.terminal = this.elapsed();
    this.log.turn({
      attemptId: this.intent.attemptId,
      pluginVersionId: this.intent.pluginVersionId,
      outcome,
      ...(code ? { code } : {}),
      statusCode,
      totalMs: this.phases.terminal,
      phases: { ...this.phases },
      unavailableServers: this.unavailableServers,
    });
  }

  /** Only ever before `finish`, which stops the watchdog. */
  private stalled(): void {
    this.log.stalled({
      attemptId: this.intent.attemptId,
      pluginVersionId: this.intent.pluginVersionId,
      lastPhase: this.lastPhase,
      elapsedMs: this.elapsed(),
      phases: { ...this.phases },
    });
  }
}

const currentTrace = new AsyncLocalStorage<OnboardingTurnTrace>();

/** Mark a phase of the onboarding turn this code runs in, if it is one. */
export function markOnboardingPhase(
  phase: Exclude<OnboardingTurnPhase, "terminal">,
): void {
  currentTrace.getStore()?.mark(phase);
}

const FIRST_OUTPUT = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-available",
]);

function readChunk(trace: OnboardingTurnTrace, chunk: unknown): void {
  if (!chunk || typeof chunk !== "object") return;
  const { type, data } = chunk as { type?: unknown; data?: unknown };
  if (type === "start-step") trace.mark("model");
  else if (typeof type === "string" && FIRST_OUTPUT.has(type)) {
    trace.mark("model");
    trace.mark("first_output");
  } else if (type === "finish") trace.finish("success", 200);
  else if (type === "error") trace.finish("error", 200, "stream_error");
  else if (type === PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE) {
    const servers = (data as { servers?: unknown } | null)?.servers;
    if (Array.isArray(servers)) trace.countUnavailable(servers.length);
  }
}

/**
 * Reads the turn's UI message stream (`data: <chunk>` events) for its
 * phases. Every byte passes through unchanged; a chunk it cannot read is
 * skipped.
 */
export function observeOnboardingStream(
  trace: OnboardingTurnTrace,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  const readEvents = (text: string) => {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      try {
        readChunk(trace, JSON.parse(line.slice("data: ".length)));
      } catch {
        // Not JSON: nothing to read from it, and the bytes already went on.
        continue;
      }
    }
  };
  // `cancel` (the reader went away) runs on Node 22, which the engines field
  // requires, though the DOM lib's Transformer type does not list it yet.
  const transformer: Transformer<Uint8Array, Uint8Array> & {
    cancel: () => void;
  } = {
    transform(bytes, controller) {
      controller.enqueue(bytes);
      pending += decoder.decode(bytes, { stream: true });
      const end = pending.lastIndexOf("\n\n");
      if (end === -1) return;
      readEvents(pending.slice(0, end));
      pending = pending.slice(end + 2);
    },
    flush() {
      readEvents(pending + decoder.decode());
      trace.finish("error", 200, "ended_without_finish");
    },
    cancel() {
      trace.finish("cancelled", 499);
    },
  };
  return new TransformStream(transformer);
}

async function onboardingIntentOf(
  c: Context,
): Promise<PluginOnboardingIntent | undefined> {
  try {
    const body: unknown = await c.req.json();
    const messages = (body as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) return undefined;
    return readPluginOnboardingIntent(
      messages.filter(
        (message): message is { role: string; metadata?: unknown } =>
          !!message &&
          typeof message === "object" &&
          typeof (message as { role?: unknown }).role === "string",
      ),
    );
  } catch {
    // Not JSON, or an attempt id that does not parse. The route answers the
    // body as it always did, and the turn is not traced.
    return undefined;
  }
}

/**
 * Traces a chat turn whose last user message starts a plugin onboarding
 * attempt. Every other turn passes through untouched.
 */
export const onboardingTurnTraceMiddleware: MiddlewareHandler = async (
  c,
  next,
) => {
  const intent = await onboardingIntentOf(c);
  if (!intent) return next();
  const requestLogger = getRequestLogger(c, "plugin-host.onboarding-trace");
  // A trace that cannot be logged must not break the turn it describes.
  const emit = <
    E extends "plugin.onboarding.turn" | "plugin.onboarding.turn.stalled",
  >(
    event: E,
    payload: RequestEventMap[E],
  ) => {
    try {
      requestLogger.event(event, payload);
    } catch (error) {
      logger.warn("[onboarding-trace] could not log the turn", {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const trace = new OnboardingTurnTrace(intent, {
    turn: (payload) => emit("plugin.onboarding.turn", payload),
    stalled: (payload) => emit("plugin.onboarding.turn.stalled", payload),
  });
  c.req.raw.signal.addEventListener(
    "abort",
    () => trace.finish("cancelled", 499),
    { once: true },
  );
  await currentTrace.run(trace, next);
  const response = c.res;
  if (!response.ok || !response.body) {
    trace.finish("error", response.status, `http_${response.status}`);
    return;
  }
  c.res = new Response(
    response.body.pipeThrough(observeOnboardingStream(trace)),
    response,
  );
};
