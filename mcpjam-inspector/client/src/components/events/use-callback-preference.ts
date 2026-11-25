import { useEffect, useState } from "react";
import { checkCallbackUrl, type ReceiverChoice } from "@mcpjam/sdk/browser";

type Draft = { kind: ReceiverChoice["kind"]; url: string };
const defaultDraft: Draft = { kind: "local", url: "" };

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
  const key = serverId ? `mcpjam-events-callback:${JSON.stringify([projectId ?? null, serverId])}` : undefined;
  const [draft, setDraft] = useState(() => readPreference(key));
  useEffect(() => setDraft(readPreference(key)), [key]);

  const remember = (value: ReceiverChoice) => {
    if (!key) return;
    try {
      if (value.kind === "local") window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value.baseUrl || "custom");
    } catch {
      // Keep the in-memory selection when storage is unavailable.
      return;
    }
  };

  return { draft, setDraft, remember };
}
