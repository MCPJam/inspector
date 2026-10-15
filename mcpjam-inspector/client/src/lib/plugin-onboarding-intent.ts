import { create } from "zustand";
import { z } from "zod";
import type { PluginSignInBinding } from "@/lib/hosted-oauth-callback";
import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";
import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";
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
  /** The plugin itself, which onboards by itself when it has no server. */
  pluginId: string;
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
        const message =
          intent.serverIds.length > 0
            ? `Couldn't start ${intent.pluginName} setup. Open the Playground with a client that has OpenAI plugin extensions on and the plugin's server selected, then use Run onboarding from the server's menu.`
            : `Couldn't start ${intent.pluginName} setup. Open the Playground with a client that has OpenAI plugin extensions on, then use Set up from the plugin's settings.`;
        logPluginExtensionIssue({
          code: "PLUGIN_ONBOARDING_NOT_STARTED",
          level: "warning",
          message,
          detail: { serverIds: intent.serverIds, pluginId: intent.pluginId },
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

/**
 * How long a Set up kept for a sign-in waits, first for the sign-in and then
 * from its completion: a hosted sign-in's lifetime.
 */
export const PLUGIN_ONBOARDING_RESUME_TTL_MS = 10 * 60_000;
const RESUME_KEY = "mcp-plugin-onboarding-resume";
const resumeSchema = z.object({
  savedAt: z.number(),
  /** Set when this tab's hosted callback stored that sign-in's credential. */
  completed: z.literal(true).optional(),
  /** The server the member left to sign in to. */
  signIn: z.object({
    pluginVersionId: z.string(),
    componentKey: z.string(),
  }),
  request: z.object({
    projectId: z.string(),
    serverIds: z.array(z.string()),
    pluginId: z.string(),
    pluginName: z.string(),
    conversation: z.enum(["new", "current"]),
  }),
});
type KeptSetUp = z.infer<typeof resumeSchema>;

function readKeptSetUp(): KeptSetUp | null {
  try {
    const parsed = resumeSchema.safeParse(
      JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? "null"),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    // Unreadable or blocked storage: nothing to resume, and the next Set up
    // writes it afresh.
    return null;
  }
}

function writeKeptSetUp(kept: KeptSetUp): void {
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(kept));
  } catch {
    // Blocked or full storage keeps nothing: the sign-in still runs, and Set
    // up is asked for again after it.
  }
}

/**
 * Set up for a plugin whose server needs the member's sign-in first. The
 * sign-in leaves the page, so the request waits in this tab for the
 * Playground's first plugins read after it.
 */
export function requestOnboardingAfterSignIn(
  request: Omit<PluginOnboardingIntent, "id" | "createdAt">,
  signIn: PluginSignInBinding,
  now = Date.now(),
): void {
  writeKeptSetUp({ request, signIn, savedAt: now });
}

/**
 * The hosted callback stored the credential for this sign-in. Only a request
 * marked here resumes, so a sign-in finished in another tab or on another
 * device, after this one was left, starts nothing.
 */
export function markOnboardingSignInCompleted(
  signIn: PluginSignInBinding | undefined,
  now = Date.now(),
): void {
  if (!signIn) return;
  const kept = readKeptSetUp();
  if (
    kept?.signIn.pluginVersionId === signIn.pluginVersionId &&
    kept.signIn.componentKey === signIn.componentKey
  ) {
    writeKeptSetUp({ ...kept, completed: true, savedAt: now });
  }
}

/** Drop the kept request: its sign-in never left, or another one started. */
export function cancelOnboardingAfterSignIn(): void {
  try {
    sessionStorage.removeItem(RESUME_KEY);
  } catch {
    // Storage that refuses access holds no request to drop.
  }
}

/** Whether a Set up for this project is waiting on a sign-in. */
export function hasOnboardingAfterSignIn(projectId: string): boolean {
  return readKeptSetUp()?.request.projectId === projectId;
}

/**
 * Settle this project's kept request on a plugins read that answered: make
 * it, once, when this tab's callback marked its sign-in completed and the
 * server reads as usable, and drop it otherwise. A sign-in the member left or
 * the authorization server denied is never marked, so a later sign-in,
 * another way, starts nothing.
 */
export function resumeOnboardingAfterSignIn(
  projectId: string,
  plugins: readonly ActivePluginRow[],
  now = Date.now(),
): void {
  const kept = readKeptSetUp();
  if (!kept || kept.request.projectId !== projectId) return;
  cancelOnboardingAfterSignIn();
  if (!kept.completed || now - kept.savedAt > PLUGIN_ONBOARDING_RESUME_TTL_MS)
    return;
  const signedIn = plugins.some(
    (plugin) =>
      plugin.status === "active" &&
      plugin.pluginVersionId === kept.signIn.pluginVersionId &&
      plugin.servers.some(
        (server) =>
          server.componentKey === kept.signIn.componentKey &&
          !server.unavailable,
      ),
  );
  if (signedIn) usePluginOnboardingIntentStore.getState().request(kept.request);
}
