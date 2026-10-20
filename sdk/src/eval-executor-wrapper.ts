import type { EvalRunContext } from "./eval-run-start.js";
import {
  EvalBillingError,
  payEvalIteration,
} from "./eval-iteration-payment.js";
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

export function wrapBillableExecutor(
  executor: HostExecutor,
  billableSteps: number
) {
  let issued = 0;
  let violation: EvalBillingError | undefined;
  const assertWithinBudget = () => {
    if (violation) throw violation;
  };
  const wrap = (agent: HostExecutor): HostExecutor => ({
    ...agent,
    run: (message, options) => {
      if (++issued > billableSteps) {
        violation ??= new EvalBillingError(
          `This eval exceeded its ${billableSteps} declared prompts. Increase billableSteps before running it again.`,
          "BILLABLE_STEPS_EXCEEDED"
        );
      }
      assertWithinBudget();
      return agent.run(message, options);
    },
    withOptions: (options) => wrap(agent.withOptions(options)),
    getPromptHistory: () => agent.getPromptHistory(),
    resetPromptHistory: () => agent.resetPromptHistory(),
  });
  return { executor: wrap(executor), assertWithinBudget };
}

export async function executePaidIterations<T>(
  context: EvalRunContext,
  options: {
    total: number;
    concurrency: number;
    caseId: string;
    billableSteps: number;
    signal?: AbortSignal;
  },
  execute: (index: number) => Promise<T>,
  state: { error?: unknown }
): Promise<Array<T & { billingPaymentId: string }>> {
  const results: Array<T & { billingPaymentId: string }> = [];
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, options.total) },
      async () => {
        while (next < options.total && state.error === undefined) {
          const index = next++;
          try {
            const billingPaymentId = await payEvalIteration(
              context,
              {
                iterationKey: crypto.randomUUID(),
                caseId: options.caseId,
                billableSteps: options.billableSteps,
              },
              options.signal
            );
            results[index] = { ...(await execute(index)), billingPaymentId };
          } catch (error) {
            state.error ??= error;
          }
        }
      }
    )
  );
  return results.filter((result) => result !== undefined);
}
