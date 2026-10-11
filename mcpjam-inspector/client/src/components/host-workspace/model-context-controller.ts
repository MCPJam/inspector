import {
  parsePluginModelContext,
  pluginContextAttachments,
  type PluginModelContextParams,
  pluginContextSnapshotSchema,
  type PluginContextSnapshot,
} from "@/shared/plugin-model-context";

export class PluginContextUpdateRejected extends Error {}
/** The person removed this App's context; its own updates stay refused until
 * they use the App again. */
export class PluginContextHeld extends PluginContextUpdateRejected {}
/** Serialize replaces. An uncertain delivery cannot silently retry or reorder state. */
export function createModelContextController({
  requireLive,
  send,
  sendRemoval,
  read,
  onSnapshot,
  userAttaching,
  onHeld,
}: {
  requireLive: () => void;
  send: (request: {
    operationId: string;
    sequence: number;
    params: PluginModelContextParams;
    attach?: "user";
  }) => Promise<unknown>;
  sendRemoval?: (request: {
    operationId: string;
    updateId: string;
    index: number;
  }) => Promise<unknown>;
  onSnapshot?: (snapshot: PluginContextSnapshot) => void;
  read?: () => Promise<unknown>;
  /**
   * Whether the person is using the App as it sends an update (read when the
   * App asks). After a removal only such an update attaches context again;
   * the server holds the same line, so a remounted App is held too.
   */
  userAttaching?: () => boolean;
  onHeld?: (error: PluginContextHeld) => void;
}) {
  let sequence = 0;
  let uncertain = false;
  let held = false;
  let tail = Promise.resolve();
  let snapshot: PluginContextSnapshot = {
    revision: 0,
    sequence: 0,
    state: null,
  };
  const acceptSnapshot = (value: unknown) => {
    const next = pluginContextSnapshotSchema.parse(value);
    if (next.state)
      parsePluginModelContext({
        content: next.state.content,
        structuredContent: next.state.structuredContent,
      });
    if (next.revision < snapshot.revision) return false;
    if (
      next.revision === snapshot.revision &&
      JSON.stringify(next) !== JSON.stringify(snapshot)
    )
      throw new Error("Invalid app context revision");
    snapshot = structuredClone(next);
    sequence = snapshot.sequence;
    onSnapshot?.(structuredClone(snapshot));
    return true;
  };
  const enqueue = <T>(execute: () => Promise<T>, allowUncertain = false) => {
    const pending = tail.then(async () => {
      requireLive();
      if (uncertain && !allowUncertain)
        throw new Error(
          "App context outcome unknown; resolve its current state before updating it",
        );
      try {
        return await execute();
      } catch (error) {
        if (!(error instanceof PluginContextUpdateRejected)) uncertain = true;
        throw error;
      }
    });
    tail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
  const update = (value: unknown) => {
    const params = parsePluginModelContext(value);
    const user = userAttaching?.() === true;
    return enqueue(async () => {
      if (held && !user) {
        const refusal = new PluginContextHeld(
          "Context was removed from this chat. Use the App to attach it again.",
        );
        onHeld?.(refusal);
        throw refusal;
      }
      let result: unknown;
      try {
        result = await send({
          operationId: crypto.randomUUID(),
          sequence: sequence + 1,
          params,
          ...(user ? { attach: "user" as const } : {}),
        });
      } catch (error) {
        if (error instanceof PluginContextHeld) {
          held = true;
          onHeld?.(error);
        }
        throw error;
      }
      held = false;
      requireLive();
      const updateId = (
        result as {
          _meta?: { "openai/modelContext"?: { updateId?: unknown } };
        }
      )?._meta?.["openai/modelContext"]?.updateId;
      if (typeof updateId !== "string" || !updateId)
        throw new Error("Invalid app context acknowledgement");
      if (onSnapshot) {
        if (!acceptSnapshot((result as { snapshot?: unknown }).snapshot))
          throw new Error("Stale app context acknowledgement");
      } else sequence++;
      return { _meta: { "openai/modelContext": { updateId } } };
    });
  };
  return Object.assign(update, {
    restore: acceptSnapshot,
    /** Explicit reconciliation reads current state; it never retries the failed effect. */
    refresh: () =>
      enqueue(async () => {
        if (!read) throw new Error("App context read unavailable");
        const current = await read();
        requireLive();
        if (!acceptSnapshot(current)) throw new Error("Stale app context read");
        uncertain = false;
      }, true),
    remove: (updateId: string, index: number) =>
      enqueue(async () => {
        if (
          !sendRemoval ||
          snapshot.state?.updateId !== updateId ||
          !Number.isSafeInteger(index) ||
          !pluginContextAttachments(snapshot).some(
            (item) => item.index === index,
          )
        )
          throw new PluginContextUpdateRejected(
            "App context changed; review the current attachment",
          );
        const result = await sendRemoval({
          operationId: crypto.randomUUID(),
          updateId,
          index,
        });
        // The server now refuses the App's own updates too.
        held = true;
        requireLive();
        acceptSnapshot(result);
      }),
  });
}
