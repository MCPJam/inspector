import type { UIMessage } from "ai";
import { toast } from "sonner";
import { buildSkillContextMessages } from "@/components/chat-v2/shared/chat-helpers";
import {
  createThreadAppApi,
  type PluginOnboardingTarget,
  type ThreadAppScope,
} from "@/components/host-workspace/thread-app-api";
import type { RunPluginOnboarding } from "@/components/host-workspace/use-plugin-onboarding";
import type { UseChatSessionReturn } from "@/hooks/use-chat-session";
import type { useChatThreadTransition } from "@/hooks/use-chat-thread-transition";
import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";
import type {
  PluginOnboardingIntent,
  PluginOnboardingSpec,
} from "@/shared/plugin-onboarding";

/**
 * Running a plugin's packaged onboarding skill in the Playground's chat. The
 * Apps menu's Run onboarding and an import's Set up both end here.
 *
 * Both functions are made from one render of the chat surface.
 * `PlaygroundMain` remakes them on every render and keeps the latest behind a
 * ref, so a run that opened a new chat sends through that chat's render, not
 * the one it started in.
 */

/** What the chat had when onboarding was asked for, checked again before sending. */
export interface PlaygroundOnboardingLive {
  ownerKey: string;
  scope: ThreadAppScope | null;
  servers: ReadonlyArray<{ serverId: string }>;
}

export type SendPluginOnboarding = (
  spec: PluginOnboardingSpec,
  onboardingTarget: PluginOnboardingTarget,
  threadId: string,
  ownerKey: string,
  sourceSignal?: AbortSignal,
) => Promise<void>;

/** The chat surface's state and actions, as of one render. */
export interface PlaygroundOnboardingDeps {
  onboardingLiveRef: { readonly current: PlaygroundOnboardingLive };
  isCompareMode: boolean;
  sendBlocked: boolean;
  composerDisabled: boolean;
  conversationSendBlockedRef: { readonly current: boolean };
  ensureSelectedServerReadyForChat: () => Promise<boolean>;
  ensureThreadReadyForSend: () => Promise<boolean>;
  ensureLocalHarnessReadyForSend: () => Promise<boolean>;
  setMessages: UseChatSessionReturn["setMessages"];
  trackSendMessage: (captureProps?: Record<string, unknown>) => void;
  sendMessage: UseChatSessionReturn["sendMessage"];
  outgoingSenderMetadata: Record<string, unknown> | undefined;
  onFirstMessageSent?: () => void;
  extensionThreadTransition: ReturnType<typeof useChatThreadTransition>;
}

export function createPluginOnboardingSend({
  onboardingLiveRef,
  isCompareMode,
  sendBlocked,
  composerDisabled,
  conversationSendBlockedRef,
  ensureSelectedServerReadyForChat,
  ensureThreadReadyForSend,
  ensureLocalHarnessReadyForSend,
  setMessages,
  trackSendMessage,
  sendMessage,
  outgoingSenderMetadata,
  onFirstMessageSent,
}: PlaygroundOnboardingDeps): SendPluginOnboarding {
  return async (spec, onboardingTarget, threadId, ownerKey, sourceSignal) => {
    const target = onboardingLiveRef.current;
    const isCurrent = () => {
      const live = onboardingLiveRef.current;
      return (
        !sourceSignal?.aborted &&
        live.ownerKey === ownerKey &&
        live.scope?.threadId === threadId &&
        // A plugin with no server has none to keep in the chat. The re-read
        // below admits it again.
        (typeof onboardingTarget !== "string" ||
          live.servers.some((server) => server.serverId === onboardingTarget))
      );
    };
    if (
      !target.scope ||
      !isCurrent() ||
      isCompareMode ||
      sendBlocked ||
      composerDisabled ||
      conversationSendBlockedRef.current
    ) {
      throw new Error("Onboarding is unavailable");
    }
    if (
      !(await ensureSelectedServerReadyForChat()) ||
      !isCurrent() ||
      !(await ensureThreadReadyForSend()) ||
      !isCurrent() ||
      !(await ensureLocalHarnessReadyForSend()) ||
      !isCurrent()
    ) {
      throw new Error("Onboarding was cancelled");
    }
    const timeout = AbortSignal.timeout(30_000);
    const signal = sourceSignal
      ? AbortSignal.any([sourceSignal, timeout])
      : timeout;
    // Re-read the same saved source under the destination's current authority.
    // The source menu's cached bytes are never used to send a new chat turn.
    const fresh = await createThreadAppApi(target.scope).onboarding(
      onboardingTarget,
      true,
      signal,
    );
    if (
      !isCurrent() ||
      !fresh.spec ||
      !fresh.available ||
      fresh.spec.pluginVersionId !== spec.pluginVersionId ||
      fresh.spec.bundleHash !== spec.bundleHash ||
      fresh.spec.skill.skillId !== spec.skill.skillId ||
      fresh.spec.skill.contentHash !== spec.skill.contentHash
    ) {
      throw new Error("Onboarding changed. Open its menu again.");
    }
    const skillMessages = buildSkillContextMessages([
      {
        name: fresh.spec.skill.name,
        description: fresh.spec.skill.description,
        content: fresh.spec.skill.content,
        path: fresh.spec.onboarding.modelRef,
      },
    ]) as UIMessage[];
    setMessages((previous) => [...previous, ...skillMessages]);
    trackSendMessage({ single_model_send: true });
    // One id per try. The server traces the turn under it, and Logs show
    // it, so a stalled try can be found even after a later one works.
    const pluginOnboarding: PluginOnboardingIntent = {
      pluginVersionId: fresh.spec.pluginVersionId,
      attemptId: crypto.randomUUID(),
    };
    const sent = await sendMessage({
      text: "Run the attached onboarding skill.",
      metadata: { ...outgoingSenderMetadata, pluginOnboarding },
    });
    if (!sent) throw new Error("Onboarding could not start. Try again.");
    logPluginExtensionIssue({
      code: "PLUGIN_ONBOARDING_STARTED",
      level: "info",
      message: `Started ${fresh.spec.name} onboarding.`,
      detail: pluginOnboarding,
      dedupeKey: `onboarding:${pluginOnboarding.attemptId}`,
    });
    onFirstMessageSent?.();
  };
}

export function createPluginOnboardingRun({
  onboardingLiveRef,
  sendBlocked,
  isCompareMode,
  conversationSendBlockedRef,
  extensionThreadTransition,
  sendPluginOnboardingRef,
}: PlaygroundOnboardingDeps & {
  sendPluginOnboardingRef: { readonly current: SendPluginOnboarding };
}): RunPluginOnboarding {
  return async (spec, conversation, signal, onboardingTarget) => {
    const source = onboardingLiveRef.current;
    const isSourceCurrent = () =>
      !signal.aborted &&
      !!source.scope &&
      onboardingLiveRef.current.ownerKey === source.ownerKey &&
      onboardingLiveRef.current.scope?.threadId === source.scope.threadId;
    try {
      if (
        !source.scope ||
        !isSourceCurrent() ||
        sendBlocked ||
        isCompareMode ||
        conversationSendBlockedRef.current
      )
        throw new Error("Onboarding is unavailable");
      const targetThread =
        conversation === "new"
          ? await extensionThreadTransition.begin(isSourceCurrent)
          : source.scope.threadId;
      if (!targetThread) throw new Error("Onboarding was cancelled");
      // A successful ordinary new-chat transition ends the source lifetime.
      // The destination is freshly admitted above; do not reuse its aborted signal.
      await sendPluginOnboardingRef.current(
        spec,
        onboardingTarget,
        targetThread,
        source.ownerKey,
        conversation === "current" ? signal : undefined,
      );
    } catch (error) {
      toast.error("Couldn’t run onboarding. Try again.");
      throw error;
    }
  };
}
