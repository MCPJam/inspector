import { useEffect, useRef } from "react";
import { isNativeHarnessTrialRefusal } from "@/lib/mcpjam-limit";
import {
  useNativeHarnessLimitDialogStore,
  type NativeHarnessSwitchHandoff,
} from "@/stores/native-harness-limit-dialog-store";

/**
 * While this chat's last turn is a native turn the trial refused, the limit
 * dialog's switch is followed by a new chat with the refused message back in
 * the composer: the switch only applies to new chats, since a chat stays on
 * the harness it started on. Registered for exactly that window, so a switch
 * only resets a refused chat whose client actually switched.
 */
export function useNativeHarnessHandoff(args: {
  error: Error | undefined;
  projectId: string | null | undefined;
  hostId: string | null | undefined;
  chatSessionId: string;
  refusedText: string;
  /** Resolves false when the person keeps the current chat. */
  startNewChat: (options: { isCurrent: () => boolean }) => Promise<boolean>;
  setComposerInput: (text: string) => void;
}): void {
  const message = args.error?.message;
  const refused =
    typeof message === "string" && isNativeHarnessTrialRefusal({ message });
  const latest = useRef(args);
  latest.current = args;

  useEffect(() => {
    if (!refused) return;
    const afterSwitch: NativeHarnessSwitchHandoff = (result) => {
      const current = latest.current;
      const { refusedText, startNewChat, setComposerInput } = current;
      if (
        result.projectId !== current.projectId ||
        !current.hostId ||
        !result.switchedHostIds.includes(current.hostId) ||
        !isNativeHarnessTrialRefusal({ message: current.error?.message })
      ) {
        return;
      }
      // New chat can wait on draft confirmation. Recheck the refused chat
      // before resetting it if the user navigates or retries in the meantime.
      void startNewChat({
        isCurrent: () => {
          const live = latest.current;
          return (
            live.projectId === current.projectId &&
            live.hostId === current.hostId &&
            live.chatSessionId === current.chatSessionId &&
            live.error === current.error &&
            useNativeHarnessLimitDialogStore.getState().afterSwitch === afterSwitch
          );
        },
      }).then((started) => {
        if (started && refusedText) setComposerInput(refusedText);
      });
    };
    const store = useNativeHarnessLimitDialogStore.getState();
    store.setAfterSwitch(afterSwitch);
    return () => {
      // Another chat may have registered since; leave its handoff alone.
      if (useNativeHarnessLimitDialogStore.getState().afterSwitch === afterSwitch) {
        useNativeHarnessLimitDialogStore.getState().setAfterSwitch(null);
      }
    };
  }, [refused]);
}
