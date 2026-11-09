/**
 * Turn a harness prompt into the Codex start payload: a string when there
 * are no images (today's shape), otherwise text + raw-base64 image parts.
 *
 * Lives next to the host adapter, not in the sandbox bundle. The bridge
 * wraps each image as `data:<mediaType>;base64,<data>` at `turn/start`.
 */
import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1Prompt,
} from "@ai-sdk/harness";

export type CodexPromptImagePart = {
  type: "image";
  data: string;
  mediaType: string;
};

export type CodexPromptTextPart = { type: "text"; text: string };

export type CodexPromptContent =
  | string
  | Array<CodexPromptTextPart | CodexPromptImagePart>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function unsupported(message: string): never {
  throw new HarnessCapabilityUnsupportedError({
    harnessId: "codex",
    message,
  });
}

function rawBase64Image(part: Record<string, unknown>): CodexPromptImagePart {
  const mediaType =
    typeof part.mediaType === "string" && part.mediaType.startsWith("image/")
      ? part.mediaType
      : "image/png";
  const data = part.image ?? part.data;
  if (typeof data !== "string" || data.length === 0) {
    unsupported(
      "Codex native images need raw base64 image parts, not a URL or bytes.",
    );
  }
  if (/^data:/i.test(data) || /^https?:\/\//i.test(data)) {
    unsupported(
      "Codex native images need raw base64 image parts, not a data URL or link.",
    );
  }
  return { type: "image", data, mediaType };
}

/**
 * No images → joined text, as today. Otherwise `{ type: "text" | "image" }`
 * parts. Accepts base64 image parts only.
 */
export function toCodexPromptContent(
  prompt: HarnessV1Prompt | undefined,
): CodexPromptContent {
  if (prompt == null) return "";
  if (typeof prompt === "string") return prompt;
  const content = (prompt as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: Array<CodexPromptTextPart | CodexPromptImagePart> = [];
  let hasImage = false;
  for (const raw of content) {
    if (!isRecord(raw) || typeof raw.type !== "string") {
      unsupported("Codex cannot send this prompt part as native input.");
    }
    if (raw.type === "text") {
      if (typeof raw.text !== "string") {
        unsupported("Codex cannot send this prompt part as native input.");
      }
      parts.push({ type: "text", text: raw.text });
      continue;
    }
    if (raw.type === "image") {
      hasImage = true;
      parts.push(rawBase64Image(raw));
      continue;
    }
    unsupported(
      `Codex does not send user message parts of type '${raw.type}' as native input.`,
    );
  }
  if (!hasImage) {
    return parts
      .filter((part): part is CodexPromptTextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n\n");
  }
  return parts;
}
