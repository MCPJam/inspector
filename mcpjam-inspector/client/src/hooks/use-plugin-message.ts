import { useCallback, useRef } from "react";
import {
  parsePluginMessage,
  pluginMessageDraftIntentSchema,
  pluginMessageIntentSchema,
  pluginMessageSendMode,
  type PluginMessageIntent,
} from "@/shared/plugin-message";
import {
  useOwnedChatAction,
  type OwnedChatActionOptions,
} from "./use-owned-chat-action";

export function usePluginMessage(
  options: Omit<OwnedChatActionOptions<PluginMessageIntent>, "accepts"> & {
    threadId: string;
  },
) {
  const current = useRef(options);
  current.current = options;
  const action = useOwnedChatAction({ ...options, accepts: () => true });
  const send = useCallback(
    async (value: PluginMessageIntent, requireLive: () => boolean) => {
      const mode = pluginMessageSendMode(parsePluginMessage(value.params));
      // A draft is checked block by block here, before any chat changes.
      const intent = (
        mode.send ? pluginMessageIntentSchema : pluginMessageDraftIntentSchema
      ).parse(value);
      if (intent.sourceThreadId !== current.current.threadId) return false;
      // An App cannot author a server transfer receipt. Only prepareNew may add it.
      if (intent.preparationToken) return false;
      if (mode.send && mode.target === "new" && !current.current.prepareNew)
        return false;
      return action.dispatch(
        intent,
        mode.target,
        requireLive,
        mode.send ? "send" : "draft",
      );
    },
    [action.dispatch],
  );
  return { send, pending: action.pending };
}
