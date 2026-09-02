/**
 * Step boundaries for an app-server turn.
 *
 * A "step" in the AI SDK sense is one model response plus the tool calls it
 * produced. Codex does not announce steps: it streams items, and the boundary
 * is implicit — the step ends when every tool item it opened has finished and
 * the model is asked again.
 *
 * So the tracker counts OPEN tool items. A step opens on the first item of any
 * kind and closes when the open-tool set drains to empty, which is exactly the
 * moment Codex goes back to the model.
 *
 * `stepToolCallCount` is deliberately NOT produced. The harness uses it to
 * collect every approval in a step before pausing; populating it requires
 * knowing a response's full tool-call set UP FRONT, and app-server streams tool
 * items one `item/started` at a time with no cardinality anywhere. Guessing
 * would make the host wait for approvals that never arrive, so the adapter
 * keeps the framework's pause-on-first behaviour, which is correct if less
 * batched.
 */

/** Item types that represent a tool the model invoked. */
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "dynamicToolCall",
]);

export type StepTracker = {
  /** An item opened. Returns true if this opened a new step. */
  itemStarted(itemId: string, itemType: string): boolean;
  /** An item closed. Returns true if the step just drained. */
  itemCompleted(itemId: string, itemType: string): boolean;
  /** Is a step currently open (i.e. does a `finish-step` need emitting)? */
  isStepOpen(): boolean;
  /** Close the step without waiting for drain (turn end / interrupt). */
  closeStep(): boolean;
  /** Are any tool items still open? */
  hasOpenTools(): boolean;
};

export function createStepTracker(): StepTracker {
  const openTools = new Set<string>();
  let stepOpen = false;

  return {
    itemStarted(itemId, itemType) {
      const opened = !stepOpen;
      stepOpen = true;
      if (TOOL_ITEM_TYPES.has(itemType)) openTools.add(itemId);
      return opened;
    },
    itemCompleted(itemId, itemType) {
      if (TOOL_ITEM_TYPES.has(itemType)) openTools.delete(itemId);
      // A step ends when its tools drain. A message-only item does not end a
      // step on its own: Codex emits the assistant message and then keeps
      // going in the same response when it also called a tool.
      if (!stepOpen || openTools.size > 0) return false;
      if (!TOOL_ITEM_TYPES.has(itemType)) return false;
      stepOpen = false;
      return true;
    },
    isStepOpen: () => stepOpen,
    closeStep() {
      if (!stepOpen) return false;
      stepOpen = false;
      openTools.clear();
      return true;
    },
    hasOpenTools: () => openTools.size > 0,
  };
}
