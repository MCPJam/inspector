import { useCallback, useRef } from "react";
import {
  parsePluginMessage,
  pluginMessageIntentSchema,
  pluginMessageTarget,
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
      const intent = pluginMessageIntentSchema.parse(value);
      intent.params = parsePluginMessage(intent.params);
      if (intent.sourceThreadId !== current.current.threadId) return false;
      // An App cannot author a server transfer receipt. Only prepareNew may add it.
      if (intent.preparationToken) return false;
      if (
        pluginMessageTarget(intent.params) === "new" &&
        !current.current.prepareNew
      )
        return false;
      return action.dispatch(
        intent,
        pluginMessageTarget(intent.params),
        requireLive,
      );
    },
    [action.dispatch],
  );
  return { send, pending: action.pending };
}
