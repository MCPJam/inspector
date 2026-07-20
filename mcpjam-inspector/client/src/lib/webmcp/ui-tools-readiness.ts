/**
 * Readiness primitive over the UI tools registry.
 *
 * Callers (e.g. a navigate handler waiting for a just-mounted surface's tool
 * group) need "are these tools live yet?" without racing registration. The
 * contract is deliberately strict: never rejects, always detaches its
 * subscription (resolve, timeout, or setup failure), so a tool that never
 * mounts can neither hang the caller nor leak a listener.
 */

import { useUiToolsRegistry } from "./ui-tools-registry";

/**
 * Resolve `true` as soon as every name in `names` is present in the registry
 * (immediately when they already are — an empty list is trivially present),
 * `false` once `timeoutMs` elapses first.
 */
export function waitForUiToolNames(
  names: readonly string[],
  timeoutMs: number,
): Promise<boolean> {
  const allPresent = () => {
    const { tools } = useUiToolsRegistry.getState();
    return names.every((name) => tools.has(name));
  };
  if (allPresent()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      resolve(value);
    };
    try {
      unsubscribe = useUiToolsRegistry.subscribe(() => {
        if (allPresent()) settle(true);
      });
      timer = setTimeout(() => settle(false), timeoutMs);
    } catch {
      // Never reject, never leak: a throwing subscribe/timer setup settles
      // like a timeout.
      settle(false);
    }
  });
}
