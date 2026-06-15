import type { UIMessage } from "@ai-sdk/react";
import { Markdown } from "../internal/markdown";

export function TextPart({
  text,
  role,
}: {
  text: string;
  role: UIMessage["role"];
}) {
  const alignmentClass = role === "user" ? "text-right" : "";
  return (
    <Markdown
      content={text}
      className={`max-w-full break-words overflow-auto text-foreground ${alignmentClass}`}
    />
  );
}
