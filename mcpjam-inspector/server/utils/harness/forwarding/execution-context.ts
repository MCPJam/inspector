import { AsyncLocalStorage } from "node:async_hooks";

/** One dispatched operation, including its awaited SDK continuation loop. */
export const forwardingExecutionContext = new AsyncLocalStorage<{
  executionId: string;
}>();
