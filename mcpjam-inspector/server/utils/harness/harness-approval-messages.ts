import type { ModelMessage } from "@ai-sdk/provider-utils";

/** A UI denial has not reached the runtime yet, despite its synthetic result. */
export function withoutSyntheticDenialResults(
  messages: ModelMessage[],
): ModelMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "tool") return messages;
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: last.content.filter(part =>
        part.type !== "tool-result" || part.output.type !== "execution-denied",
      ),
    },
  ];
}
