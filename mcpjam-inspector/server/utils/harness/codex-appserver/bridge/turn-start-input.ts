/**
 * Map a start-message prompt onto `turn/start.input`.
 *
 * Image parts arrive as raw base64. The URL is that payload with a single
 * `data:<mediaType>;base64,` prefix — never a second `data:` wrap.
 *
 * The prompt shape is duplicated from the host adapter so this sandbox
 * bundle does not import `@ai-sdk/harness`.
 */
type CodexPromptContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mediaType: string }
    >;

export type CodexTurnStartInput = Array<
  { type: "text"; text: string } | { type: "image"; url: string }
>;

export function toCodexTurnStartInput(
  prompt: CodexPromptContent,
): CodexTurnStartInput {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }
  return prompt.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return {
      type: "image",
      url: `data:${part.mediaType};base64,${part.data}`,
    };
  });
}
