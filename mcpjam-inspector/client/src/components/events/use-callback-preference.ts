import { useEffect, useState } from "react";
import { checkCallbackUrl, type ReceiverChoice } from "@mcpjam/sdk/browser";

type Draft = { kind: ReceiverChoice["kind"]; url: string };
const defaultDraft: Draft = { kind: "local", url: "" };

function preferenceKey(
  projectId: string | null | undefined,
  serverId: string | undefined,
): string | undefined {
  return serverId
    ? `mcpjam-events-callback:${JSON.stringify([projectId ?? null, serverId])}`
    : undefined;
}

function readPreference(key: string | undefined): Draft {
  if (!key) return defaultDraft;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "custom") return { kind: "custom", url: "" };
    if (!stored) return defaultDraft;
    const checked = checkCallbackUrl(stored);
    return checked.ok ? { kind: "custom", url: checked.url.href } : defaultDraft;
  } catch {
    // Storage can be disabled on this device. The form still works in memory.
    return defaultDraft;
  }
}

export function useCallbackPreference(
  projectId: string | null | undefined,
  serverId: string | undefined,
) {
  const key = preferenceKey(projectId, serverId);
  const [draft, setDraft] = useState(() => readPreference(key));
  // The preference as saved for this server, which edits to the draft don't move.
  const [saved, setSaved] = useState(draft);
  useEffect(() => {
    const stored = readPreference(key);
    setDraft(stored);
    setSaved(stored);
  }, [key]);

  const remember = (value: ReceiverChoice) => {
    if (!key) return;
    // The next subscription on this server starts from what was just saved,
    // even if storage is unavailable.
    setSaved(
      value.kind === "local"
        ? defaultDraft
        : { kind: "custom", url: value.baseUrl },
    );
    try {
      if (value.kind === "local") window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value.baseUrl || "custom");
    } catch {
      // Keep the in-memory selection when storage is unavailable.
      return;
    }
  };

  return { draft, setDraft, saved, remember };
}

/**
 * The `https` receiver saved for a local server, if one is. A plain-`http`
 * receiver needs the user's consent for each subscription, so it doesn't count.
 */
export function savedHttpsReceiver(
  projectId: string | null | undefined,
  serverId: string,
): string | undefined {
  return httpsReceiverOf(readPreference(preferenceKey(projectId, serverId)));
}

/** The draft's receiver URL when it is a valid `https` one. */
export function httpsReceiverOf(draft: Draft): string | undefined {
  if (draft.kind !== "custom") return undefined;
  const checked = checkCallbackUrl(draft.url);
  return checked.ok && !checked.insecure ? checked.url.href : undefined;
}
