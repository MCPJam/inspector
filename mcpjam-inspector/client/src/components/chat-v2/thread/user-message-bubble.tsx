/**
 * UserMessageBubble
 *
 * Reusable user message component that displays text in a chat bubble.
 * Used by both ChatTabV2's Thread and the UI Playground for consistent styling.
 */

import { useSandboxHostStyle } from "@/contexts/sandbox-host-style-context";

interface UserMessageBubbleProps {
  children: React.ReactNode;
  className?: string;
}

export function UserMessageBubble({
  children,
  className = "",
}: UserMessageBubbleProps) {
  const sandboxHostStyle = useSandboxHostStyle();
  const bubbleClasses =
    sandboxHostStyle === "chatgpt"
      ? "sandbox-host-user-bubble rounded-[1.5rem] border-transparent bg-[#f4f4f4] text-[#1f1f1f] shadow-none dark:bg-[#2f2f2f] dark:text-[#f5f5f5]"
      : sandboxHostStyle === "claude"
        ? "sandbox-host-user-bubble rounded-xl border-[#d9d1c5] bg-[#f5f0e8] text-[#2d2926] shadow-none dark:border-[#4c473f] dark:bg-[#3a3832] dark:text-[#f2ede6]"
        : "rounded-xl border border-[#e5e7ec] bg-[#f9fafc] text-[#1f2733] shadow-sm dark:border-[#4a5261] dark:bg-[#2f343e] dark:text-[#e6e8ed]";

  return (
    <div className={`flex justify-end ${className}`}>
      <div
        className={`max-w-3xl max-h-[70vh] space-y-3 overflow-auto overscroll-contain px-4 py-3 text-sm leading-6 ${bubbleClasses}`}
      >
        {children}
      </div>
    </div>
  );
}
