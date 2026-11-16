import { createContext, useContext } from "react";
import type { DisplayBehavior } from "@mcpjam/sdk/widget-runtime";

/**
 * How the client picks display modes for the Apps in a chat while its plugin
 * extensions run (`displayBehaviorForHost`). It reaches every App the model
 * opens there, not only the ones the plugin host owns: the host owns a model
 * App only on its Forms path, and Claude's clients leave Forms off.
 *
 * Absent outside such a chat (tools panel, replays, extensions off), where
 * modes are negotiated as before.
 */
const ChatAppDisplayBehaviorContext = createContext<
  DisplayBehavior | undefined
>(undefined);

export const ChatAppDisplayBehaviorProvider =
  ChatAppDisplayBehaviorContext.Provider;

export function useChatAppDisplayBehavior(): DisplayBehavior | undefined {
  return useContext(ChatAppDisplayBehaviorContext);
}
