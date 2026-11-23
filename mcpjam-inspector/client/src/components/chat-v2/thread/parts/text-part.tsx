import type { UIMessage } from "@ai-sdk/react";
import { useScenarioHostStyle } from "@/contexts/scenario-client-style-context";
import { getScenarioTerminalClient } from "@/lib/scenario-client-style";

import { MemoizedMarkdown } from "../memomized-markdown";
import "./terminal-chat.css";

export function TextPart({
  text,
  role,
  showTerminalMarker = false,
}: {
  text: string;
  role: UIMessage["role"];
  showTerminalMarker?: boolean;
}) {
  const terminal = getScenarioTerminalClient(useScenarioHostStyle());
  if (terminal) {
    return (
      <div
        data-terminal-markdown={terminal}
        className="flex min-w-0 gap-2 font-mono text-[13px] leading-5 text-foreground"
      >
        {showTerminalMarker && (
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            {terminal === "claude-code" ? "⏺" : "•"}
          </span>
        )}
        <div className="min-w-0 flex-1 break-words">
          <MemoizedMarkdown content={text} />
        </div>
      </div>
    );
  }
  const textColorClass =
    role === "user" ? "text-inherit" : "text-foreground";
  return (
    <MemoizedMarkdown
      content={text}
      className={`max-w-full break-words overflow-auto ${textColorClass}`}
    />
  );
}
