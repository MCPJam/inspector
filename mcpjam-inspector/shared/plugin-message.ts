import { z } from "zod";
import type { UIMessage } from "ai";
import { OpenAIMessageParamsSchema } from "@openai/mcp-extensions/app";
import { pluginResourceLinkModelText } from "./plugin-resource-link.js";
import {
  assertPluginResourceRepresentations,
  parsePluginModelContext,
  pluginInlineContentBlock,
} from "./plugin-model-context.js";

/** Full envelope; supplied bytes and inert reference data share the context codec. */
export function parsePluginMessage(value: unknown) {
  assertPluginResourceRepresentations(value);
  const params = OpenAIMessageParamsSchema.parse(value);
  if (!params.content.length || params.content.length > 64)
    throw new Error("PLUGIN_MESSAGE_CONTENT_INVALID");
  parsePluginModelContext({
    content: params.content,
    ...(params._meta ? { _meta: params._meta } : {}),
  });
  return structuredClone(params);
}
export type PluginMessageParams = ReturnType<typeof parsePluginMessage>;

/** Private, one-turn transport input. Never stamp handles into UI history. */
export const pluginMessageIntentSchema = z.strictObject({
  instanceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  operationId: z.string().uuid(),
  preparationToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  sourceThreadId: z.string().min(1).max(256),
  params: z.unknown().transform((value, context) => {
    try {
      return parsePluginMessage(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid app message content",
      });
      return z.NEVER;
    }
  }),
});
export type PluginMessageIntent = z.infer<typeof pluginMessageIntentSchema>;

export function pluginMessageTarget(params: PluginMessageParams) {
  return params._meta?.["openai/message"]?.target ?? "active";
}

export const PLUGIN_MESSAGE_TEXT_PART = "data-plugin-message-text";
export const pluginMessageTextSchema = z.strictObject({
  title: z.string().min(1).max(256),
  text: z.string().max(256 * 1024),
});

/** Plain user text for edit/copy/previews. A title is presentation only and
 * never replaces the underlying instruction in a resend or test case. */
export function messagePartPlainText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const part = value as { type?: unknown; text?: unknown; data?: unknown };
  if (part.type === "text" && typeof part.text === "string") return part.text;
  if (part.type !== PLUGIN_MESSAGE_TEXT_PART) return undefined;
  const parsed = pluginMessageTextSchema.safeParse(part.data);
  return parsed.success ? parsed.data.text : undefined;
}

/** Keep block order and actual image bytes. Presentation/request metadata stays out. */
export function pluginMessageParts(value: unknown): UIMessage["parts"] {
  const params = parsePluginMessage(value);
  return params.content.map((block) => {
    const inline = pluginInlineContentBlock(block);
    const rawTitle = block._meta?.["openai/title"];
    const title =
      typeof rawTitle === "string" && rawTitle.trim()
        ? rawTitle.trim().slice(0, 256)
        : undefined;
    if (inline.type === "text")
      return title
        ? { type: PLUGIN_MESSAGE_TEXT_PART, data: { title, text: inline.text } }
        : inline;
    if (inline.type === "resource_link")
      return {
        type: "text",
        text: pluginResourceLinkModelText(inline.reference, "app-message"),
      };
    if (inline.type === "image")
      return {
        type: "file",
        mediaType: inline.mimeType,
        ...(title ? { filename: title } : {}),
        url: `data:${inline.mimeType};base64,${inline.data}`,
      };
    throw new Error("PLUGIN_MESSAGE_CONTENT_UNSUPPORTED");
  });
}
