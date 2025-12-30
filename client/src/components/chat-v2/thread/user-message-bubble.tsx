/**
 * UserMessageBubble
 *
 * Reusable user message component that displays text in a chat bubble.
 * Used by both ChatTabV2's Thread and the UI Playground for consistent styling.
 */

interface UserMessageBubbleProps {
  children: React.ReactNode;
  className?: string;
}

export function UserMessageBubble({
  children,
  className = "",
}: UserMessageBubbleProps) {
  return (
    <div className={`flex justify-end ${className}`}>
      <div className="max-w-3xl max-h-[70vh] space-y-3 overflow-auto overscroll-contain rounded-xl border border-[#e5e7ec] bg-[#f9fafc] px-4 py-3 text-sm leading-6 text-[#1f2733] shadow-sm dark:border-[#4a5261] dark:bg-[#2f343e] dark:text-[#e6e8ed]">
        {children}
      </div>
    </div>
  );
}
