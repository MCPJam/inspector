/**
 * Persisted "Tool Approval" preference for the MCPJam Agent surfaces (Home
 * takeover + side panel). Global to the agent — agent sessions have no host,
 * so the per-host `requireToolApproval` config the Playground uses does not
 * apply. Default OFF; the composer toggle flips it.
 *
 * Same lightweight localStorage + CustomEvent pattern as
 * `selected-model-storage.ts` so hero and panel stay in sync when both are
 * mounted.
 */

const STORAGE_KEY = "mcpjam:agent-require-tool-approval:v1";
const EVENT_NAME = "mcpjam:agent-require-tool-approval-changed";

export function loadAgentRequireToolApproval(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveAgentRequireToolApproval(value: boolean): void {
  try {
    if (value) {
      localStorage.setItem(STORAGE_KEY, "true");
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
  } catch {
    // ignore — worst case the toggle doesn't persist across reloads.
  }
}

export function subscribeAgentRequireToolApproval(
  callback: () => void
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) callback();
  };
  window.addEventListener(EVENT_NAME, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, callback);
    window.removeEventListener("storage", onStorage);
  };
}
