import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "./cn";

/**
 * Thin, provider-free markdown renderer. The inspector's
 * `memomized-markdown.tsx` adds per-surface link-base/trust context; the
 * read-only package keeps just the safe Streamdown render so untrusted model
 * text renders without inheriting inspector surface wiring.
 */
export const Markdown = memo(function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn("mcpjam-chat-markdown", className)}>
      <Streamdown>{content}</Streamdown>
    </div>
  );
});
