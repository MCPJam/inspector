import { z } from "zod";
import type { UIMessage } from "ai";
import { OpenAIMessageParamsSchema } from "@openai/mcp-extensions/app";
import { pluginResourceLinkModelText } from "./plugin-resource-link.js";
import { MODEL_CONTEXT_POLICY_DEFAULTS } from "@mcpjam/sdk/host-config/internal";
import {
  assertPluginResourceRepresentations,
  parsePluginModelContext,
  pluginInlineContentBlock,
} from "./plugin-model-context.js";

/** Full envelope; supplied bytes and inert reference data share the context
 * codec. A message keeps MCPJam's default budgets whatever the client's
 * context policy says. */
export function parsePluginMessage(value: unknown) {
  assertPluginResourceRepresentations(
    value,
    MODEL_CONTEXT_POLICY_DEFAULTS.maxBlocks,
  );
  const params = OpenAIMessageParamsSchema.parse(value);
  if (!params.content.length || params.content.length > 64)
    throw new Error("PLUGIN_MESSAGE_CONTENT_INVALID");
  parsePluginModelContext(
    {
      content: params.content,
      ...(params._meta ? { _meta: params._meta } : {}),
    },
    MODEL_CONTEXT_POLICY_DEFAULTS,
  );
  return structuredClone(params);
}
export type PluginMessageParams = ReturnType<typeof parsePluginMessage>;

/** Defaults to `{ target: "active", send: true }`. `send: false` asks for an
 * editable draft: it only fills the composer and never runs a turn. */
export function pluginMessageSendMode(params: PluginMessageParams) {
  const options = params._meta?.["openai/message"];
  return {
    target: options?.target ?? "active",
    send: options?.send !== false,
  } as const;
}

/** How long the server honours a new-chat message prepared while its App was
 * live. */
export const PLUGIN_MESSAGE_PREPARATION_MS = 60_000;

/** Private, one-turn transport input. Never stamp handles into UI history.
 * The send schema refuses a draft and the draft schema refuses a send, so a
 * draft can never reach a model turn. */
function pluginMessageIntent(mode: "send" | "draft") {
  return z.strictObject({
    instanceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    operationId: z.string().uuid(),
    preparationToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    sourceThreadId: z.string().min(1).max(256),
    params: z.unknown().transform((value, context) => {
      try {
        const params = parsePluginMessage(value);
        if (pluginMessageSendMode(params).send !== (mode === "send"))
          throw new Error("PLUGIN_MESSAGE_MODE_MISMATCH");
        // Every block of a draft is checked before any chat changes.
        if (mode === "draft") pluginMessageDraft(params);
        return params;
      } catch {
        context.addIssue({
          code: "custom",
          message: "Invalid app message content",
        });
        return z.NEVER;
      }
    }),
  });
}
export const pluginMessageIntentSchema = pluginMessageIntent("send");
export const pluginMessageDraftIntentSchema = pluginMessageIntent("draft");
export type PluginMessageIntent = z.infer<typeof pluginMessageIntentSchema>;

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

type PluginMessageBlock = PluginMessageParams["content"][number];

function pluginMessageTitle(block: PluginMessageBlock) {
  const raw = block._meta?.["openai/title"];
  return typeof raw === "string" && raw.trim()
    ? raw.trim().slice(0, 256)
    : undefined;
}

/** One block as the part a sent message carries. Presentation/request metadata stays out. */
function pluginMessagePart(
  block: PluginMessageBlock,
): UIMessage["parts"][number] {
  const inline = pluginInlineContentBlock(block);
  const title = pluginMessageTitle(block);
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
}

/** Keep block order and actual image bytes. */
export function pluginMessageParts(value: unknown): UIMessage["parts"] {
  return parsePluginMessage(value).content.map(pluginMessagePart);
}

/** What a draft puts in the composer. Untitled text becomes editable text and
 * images become file attachments. Titled text, resource links and embedded
 * resources stay whole: each is one removable item, sent as the same part a
 * sent message would carry. */
export interface PluginMessageDraft {
  text: string;
  images: { mimeType: string; data: string; filename?: string }[];
  items: { title: string; part: UIMessage["parts"][number] }[];
}

function draftItemTitle(block: PluginMessageBlock) {
  if (block.type === "resource_link") return block.title ?? block.name;
  if (block.type === "resource") return block.resource.uri;
  return "App message";
}

/** Checks every block; any unsupported block refuses the whole draft. */
export function pluginMessageDraft(value: unknown): PluginMessageDraft {
  const texts: string[] = [];
  const draft: PluginMessageDraft = { text: "", images: [], items: [] };
  for (const block of parsePluginMessage(value).content) {
    const part = pluginMessagePart(block);
    const title = pluginMessageTitle(block);
    if (block.type === "text" && !title) texts.push(block.text);
    else if (block.type === "image")
      draft.images.push({
        mimeType: block.mimeType,
        data: block.data,
        ...(title ? { filename: title } : {}),
      });
    else draft.items.push({ title: title ?? draftItemTitle(block), part });
  }
  draft.text = texts.join("\n\n");
  return draft;
}
