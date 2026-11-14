import type { UIMessage } from "@ai-sdk/react";
import { Markdown } from "../internal/markdown";

export function TextPart({
  text,
}: {
  text: string;
  role: UIMessage["role"];
}) {
  return (
    <Markdown
      content={text}
      className={`max-w-full break-words overflow-auto text-foreground`}
    />
  );
}
