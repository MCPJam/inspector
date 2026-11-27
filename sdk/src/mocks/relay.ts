import { LOG_LEVEL_META_KEY } from "@modelcontextprotocol/server";
import type { LoggingLevel, ServerContext } from "@modelcontextprotocol/server";
import type { MockNotifier } from "./notifier.js";
import type { MockRealCall, MockRealServer } from "./real-server.js";

export interface CallRelay extends Required<
  Pick<MockRealCall, "onProgress" | "onLog">
> {
  /** Stops listening for list changes. */
  stop: () => void;
  /** Resolves once every notification sent so far is out; rejects if one failed. */
  flush: () => Promise<void>;
}

/**
 * Passes what the real server sends during one call on to the caller: progress
 * (only when the caller asked with a progress token), log messages (filtered by
 * the caller's own log level), and list-changed notifications (sent where the
 * caller's revision wants them: `notifier`). Call `stop`
 * when the call ends and await `flush` before returning its result, so a
 * notification that could not be sent fails the call instead of vanishing.
 */
export function relayDuringCall(
  real: MockRealServer,
  progressToken: string | number | undefined,
  ctx: ServerContext,
  notifier: MockNotifier
): CallRelay {
  const sent: Promise<void>[] = [];
  let failure: { error: unknown } | undefined;
  // Remember the first failure and rethrow it from `flush`; a rejection with no
  // handler attached yet would otherwise surface as an unhandled rejection.
  const track = (sending: Promise<void>) => {
    sent.push(sending.catch((error: unknown) => void (failure ??= { error })));
  };
  const stop = real.onListChanged((kind) => track(notifier.listChanged(kind)));
  return {
    stop,
    flush: async () => {
      await Promise.all(sent);
      if (failure) throw failure.error;
    },
    onProgress: (progress) => {
      if (progressToken === undefined) return;
      track(
        ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, ...progress },
        })
      );
    },
    onLog: (log) => track(ctx.mcpReq.log(log.level, log.data, log.logger)),
  };
}

/**
 * The log level a 2026-07-28 caller sent with this request. The server SDK
 * lifts it out of `params._meta` into the request envelope, which its types
 * leave empty, so it is read by key.
 */
export function callerLogLevel(ctx: ServerContext): LoggingLevel | undefined {
  const level = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[
    LOG_LEVEL_META_KEY
  ];
  return typeof level === "string" ? (level as LoggingLevel) : undefined;
}
