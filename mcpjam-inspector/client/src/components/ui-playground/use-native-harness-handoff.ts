import { useEffect, useRef } from "react";
import { isNativeHarnessTrialRefusal } from "@/lib/mcpjam-limit";
import { useNativeHarnessLimitDialogStore } from "@/stores/native-harness-limit-dialog-store";

/**
 * While this chat's last turn is a native turn the trial refused, the limit
 * dialog's switch is followed by a new chat with the refused message back in
 * the composer: the switch only applies to new chats, since a chat stays on
 * the harness it started on. Registered for exactly that window, so a switch
 * made from a client card or a run never resets this chat.
 */
export function useNativeHarnessHandoff(args: {
  error: Error | undefined;
  refusedText: string;
  /** Resolves false when the person keeps the current chat. */
  startNewChat: () => Promise<boolean>;
  setComposerInput: (text: string) => void;
}): void {
  const message = args.error?.message;
  const refused =
    typeof message === "string" && isNativeHarnessTrialRefusal({ message });
  const latest = useRef(args);
  latest.current = args;

  useEffect(() => {
    if (!refused) return;
    const afterSwitch = () => {
      const { refusedText, startNewChat, setComposerInput } = latest.current;
      void startNewChat().then((started) => {
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
