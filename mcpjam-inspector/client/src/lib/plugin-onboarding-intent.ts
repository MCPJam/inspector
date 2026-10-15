import { create } from "zustand";
import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";
import { toast } from "@/lib/toast";

/**
 * "Set up <Plugin>" after an import: a one-shot request for the Playground to
 * run the plugin's onboarding skill through normal chat (the same path as the
 * server menu's Run onboarding). The import dialog writes it; the Playground's
 * onboarding hook takes it once one of the plugin's servers reports
 * onboarding available, and nothing else reads it.
 *
 * It expires: a setup that can't start (the server isn't in the selected
 * client, or plugin extensions are off for it) must not fire a chat turn
 * minutes later. Expiry says why, once, instead of failing silently.
 */
export const PLUGIN_ONBOARDING_INTENT_TTL_MS = 60_000;

export interface PluginOnboardingIntent {
  id: string;
  projectId: string;
  /** The plugin's materialized server ids; the first available one runs. */
  serverIds: string[];
  pluginName: string;
  /** "new" chat, or the "current" one when the import started in a chat. */
  conversation: "new" | "current";
  createdAt: number;
}

interface PluginOnboardingIntentState {
  intent: PluginOnboardingIntent | null;
  request: (
    intent: Omit<PluginOnboardingIntent, "id" | "createdAt">,
  ) => PluginOnboardingIntent;
  /** Claim the intent exactly once. Returns null if it is gone or stale. */
  take: (id: string, now?: number) => PluginOnboardingIntent | null;
  clear: () => void;
}

let expiryTimer: ReturnType<typeof setTimeout> | undefined;

export const usePluginOnboardingIntentStore =
  create<PluginOnboardingIntentState>((set, get) => ({
    intent: null,
    request: (input) => {
      const intent: PluginOnboardingIntent = {
        ...input,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
      };
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => {
        if (get().intent?.id !== intent.id) return;
        set({ intent: null });
        const message = `Couldn't start ${intent.pluginName} setup. Open the Playground with a client that has OpenAI plugin extensions on and the plugin's server selected, then use Run onboarding from the server's menu.`;
        logPluginExtensionIssue({
          code: "PLUGIN_ONBOARDING_NOT_STARTED",
          level: "warning",
          message,
          detail: { serverIds: intent.serverIds },
          dedupeKey: `onboarding:${intent.id}`,
        });
        toast.error(message);
      }, PLUGIN_ONBOARDING_INTENT_TTL_MS);
      set({ intent });
      return intent;
    },
    take: (id, now = Date.now()) => {
      const intent = get().intent;
      if (!intent || intent.id !== id) return null;
      set({ intent: null });
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = undefined;
      return now - intent.createdAt > PLUGIN_ONBOARDING_INTENT_TTL_MS
        ? null
        : intent;
    },
    clear: () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = undefined;
      set({ intent: null });
    },
  }));
