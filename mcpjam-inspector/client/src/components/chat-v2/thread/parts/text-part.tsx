import { UIMessage } from "@ai-sdk/react";

import { MemoizedMarkdown } from "../memomized-markdown";

export function TextPart({
  text,
  role,
}: {
  text: string;
  role: UIMessage["role"];
}) {
  const textColorClass =
    role === "user" ? "text-foreground" : "text-foreground";
  const alignmentClass = role === "user" ? "text-right" : "";
  return (
    <MemoizedMarkdown
      content={text}
      className={`max-w-full break-words overflow-auto ${textColorClass} ${alignmentClass}`}
    />
  );
}
