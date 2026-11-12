import { useComposerFormStore } from "@/components/elicitation/composer-form-store";
import type { PluginFormOperation } from "@/shared/plugin-form-services";

type Operation = Omit<PluginFormOperation, "expiresAt">;
/** Observe this POST's source only. Other forms cannot keep this request alive. */
export function watchOwnedLegacyInput(
  operation: Operation | undefined,
  signal: AbortSignal,
  notify?: (pending: boolean) => void,
): () => void {
  if (!operation || !notify || signal.aborted) return () => {};
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const update = () => {
    clearTimeout(timer);
    const expires = useComposerFormStore
      .getState()
      .forms.map((form) => form.operation)
      .filter(
        (value): value is PluginFormOperation =>
          !!value &&
          value.projectId === operation.projectId &&
          value.workspaceId === operation.workspaceId &&
          value.instanceId === operation.instanceId &&
          value.generation === operation.generation &&
          value.serverId === operation.serverId &&
          value.invocationId === operation.invocationId &&
          value.expiresAt > Date.now(),
      )
      .map((value) => value.expiresAt);
    const next = !closed && !signal.aborted && expires.length > 0;
    if (next !== pending) {
      pending = next;
      notify(next);
    }
    if (next)
      timer = setTimeout(
        update,
        Math.max(1, Math.min(...expires) - Date.now()),
      );
  };
  const unsubscribe = useComposerFormStore.subscribe(update);
  const stop = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    signal.removeEventListener("abort", stop);
    clearTimeout(timer);
    if (pending) {
      pending = false;
      notify(false);
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  update();
  return stop;
}
