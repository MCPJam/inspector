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
    role === "user" ? "text-inherit" : "text-foreground";
  // A message or tool result can hold a pasted secret or customer data, so
  // replay masks its text; the chrome around it stays recorded.
  return (
    <MemoizedMarkdown
      content={text}
      className={`max-w-full break-words overflow-auto ${textColorClass}`}
      hideFromReplay
    />
  );
}
