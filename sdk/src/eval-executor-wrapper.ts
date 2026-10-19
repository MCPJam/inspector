import type { HostExecutor } from "./HostExecutor.js";

function mergeAbortSignals(
  first?: AbortSignal,
  second?: AbortSignal
): AbortSignal | undefined {
  if (!first) {
    return second;
  }

  if (!second) {
    return first;
  }

  if (first.aborted) {
    return AbortSignal.abort(first.reason);
  }

  if (second.aborted) {
    return AbortSignal.abort(second.reason);
  }

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    cleanup();
    controller.abort(signal.reason);
  };
  const onFirstAbort = () => abort(first);
  const onSecondAbort = () => abort(second);
  const cleanup = () => {
    first.removeEventListener("abort", onFirstAbort);
    second.removeEventListener("abort", onSecondAbort);
  };

  first.addEventListener("abort", onFirstAbort, { once: true });
  second.addEventListener("abort", onSecondAbort, { once: true });

  return controller.signal;
}

export function wrapAgentWithAbortSignal(
  agent: HostExecutor,
  abortSignal: AbortSignal
): HostExecutor {
  return {
    run: (message, options) =>
      agent.run(message, {
        ...options,
        abortSignal: mergeAbortSignals(options?.abortSignal, abortSignal),
      }),
    withOptions: (options) =>
      wrapAgentWithAbortSignal(agent.withOptions(options), abortSignal),
    getPromptHistory: () => agent.getPromptHistory(),
    resetPromptHistory: () => agent.resetPromptHistory(),
    // Forward host-introspection methods so per-iteration metadata
    // stamping can capture the live snapshot from a HostRuntime clone.
    getHostSnapshot: agent.getHostSnapshot
      ? () => agent.getHostSnapshot!()
      : undefined,
    getServerReplayConfigs: agent.getServerReplayConfigs
      ? () => agent.getServerReplayConfigs!()
      : undefined,
  };
}
