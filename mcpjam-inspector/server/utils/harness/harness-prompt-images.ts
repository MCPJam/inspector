/**
 * Resize composer images so a harness that accepts native image parts can
 * carry them on the prompt without blowing the model-proxy size cap.
 *
 * Decode already happened in `harness-attachments.ts`. This module never
 * throws: a frame that cannot be attached is skipped with a reason the note
 * can quote. Only JPEG, PNG, GIF, and WebP magic reach Sharp: an SVG's
 * outer canvas can sit under the pixel cap while a nested raster does not.
 * The only process state is the one sharp-load promise.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { logger } from "../logger.js";
import type { HarnessPromptAttachment } from "./harness-attachments.js";

export const HARNESS_PROMPT_IMAGE_MAX_EDGE = 2576;
export const HARNESS_PROMPT_IMAGE_MAX_PIXELS = 50_000_000;
export const HARNESS_PROMPT_IMAGE_MAX_BYTES = 768 * 1024;
/** Base64 bytes of images one turn may attach (bounds the start message). */
export const HARNESS_PROMPT_IMAGE_TURN_BUDGET = 4 * 1024 * 1024;
/** Base64 bytes of images one conversation may carry natively. */
export const HARNESS_PROMPT_IMAGE_CONVERSATION_BUDGET = 8 * 1024 * 1024;
export const HARNESS_PROMPT_IMAGE_MAX_BASE64 =
  Math.ceil(HARNESS_PROMPT_IMAGE_MAX_BYTES / 3) * 4;

const WEBP_EDGES = [2576, 2048, 1568] as const;
const LIBRARY_UNAVAILABLE = "image processing isn't available on this server";
const TOO_MANY_PIXELS = "too many pixels to attach";
const TOO_LARGE = "too large to attach after resizing";
const TURN_FULL = "this message already attaches 4 MiB of images";
const CANCELLED = "the turn was cancelled";
const UNREADABLE = "it was not readable";
const NOT_RASTER = "not JPEG, PNG, GIF, or WebP";

const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38] as const;
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50] as const;

function startsWithMagic(
  bytes: Uint8Array,
  magic: readonly number[],
  offset = 0,
): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/**
 * JPEG, PNG, GIF, WebP only. Sharp's pixel cap does not apply to nested
 * rasters inside an SVG, so vector (and unknown) bytes never reach decode.
 */
export function isHarnessPromptRasterImage(bytes: Uint8Array): boolean {
  if (startsWithMagic(bytes, JPEG_MAGIC)) return true;
  if (startsWithMagic(bytes, PNG_MAGIC)) return true;
  if (startsWithMagic(bytes, GIF_MAGIC)) return true;
  return (
    startsWithMagic(bytes, RIFF_MAGIC) && startsWithMagic(bytes, WEBP_MAGIC, 8)
  );
}

export type HarnessPromptImagePart = {
  type: "image";
  image: string;
  mediaType: string;
};

export type HarnessPromptImage =
  | {
      status: "attached";
      part: HarnessPromptImagePart;
      base64Bytes: number;
    }
  | { status: "skipped"; reason: string }
  | { status: "not-image" };

type SharpFn = (input: Buffer, options?: Record<string, unknown>) => SharpPipeline;
type SharpPipeline = {
  rotate: () => SharpPipeline;
  clone: () => SharpPipeline;
  resize: (opts: {
    width: number;
    height: number;
    fit: "inside";
    withoutEnlargement: boolean;
  }) => SharpPipeline;
  metadata: () => Promise<{ format?: string }>;
  jpeg: () => SharpPipeline;
  png: () => SharpPipeline;
  webp: (opts: { quality: number }) => SharpPipeline;
  toBuffer: () => Promise<Buffer>;
};

let loadSharp: () => Promise<SharpFn>;
let sharpPromise: Promise<SharpFn | null> | undefined;
let libraryWarningEmitted = false;

function defaultSharpLoader(): Promise<SharpFn> {
  return import("sharp").then((mod) => {
    const fn = mod.default;
    if (typeof fn !== "function") {
      throw new Error("sharp did not export a function");
    }
    return fn as SharpFn;
  });
}

loadSharp = defaultSharpLoader;

function sharpLibrary(): Promise<SharpFn | null> {
  if (!sharpPromise) {
    sharpPromise = loadSharp().catch((error: unknown) => {
      if (!libraryWarningEmitted) {
        libraryWarningEmitted = true;
        logger.warn("[harness] image processing isn't available on this server", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    });
  }
  return sharpPromise;
}

/** Test seam: the production loader is a process-wide dynamic import. */
export function setHarnessPromptImageLibraryLoaderForTests(
  loader: () => Promise<SharpFn>,
): void {
  loadSharp = loader;
  sharpPromise = undefined;
  libraryWarningEmitted = false;
}

export function resetHarnessPromptImageLibraryForTests(): void {
  loadSharp = defaultSharpLoader;
  sharpPromise = undefined;
  libraryWarningEmitted = false;
}

export function shouldPrepareHarnessPromptImages(args: {
  isApprovalResume: boolean;
  promptImageInput: boolean;
  attachmentCount: number;
}): boolean {
  return (
    !args.isApprovalResume &&
    args.promptImageInput &&
    args.attachmentCount > 0
  );
}

/** Messages before the last user prompt, for the conversation budget. */
export function harnessPromptImageHistory(
  messages: ModelMessage[],
): ModelMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages.slice(0, i);
  }
  return messages;
}

function isImageAttachment(attachment: HarnessPromptAttachment): boolean {
  if (attachment.sourceType === "image") return true;
  return typeof attachment.mediaType === "string" &&
    attachment.mediaType.startsWith("image/");
}

function formatMib(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 10) return String(Math.round(mib));
  const rounded = Math.round(mib * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function conversationBudgetReason(already: number): string {
  return `this conversation already carries ${formatMib(already)} MiB of images`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function base64SizeOfImageData(data: unknown): number {
  if (typeof data === "string") {
    if (/^data:/i.test(data)) {
      const comma = data.indexOf(",");
      return comma >= 0 ? data.slice(comma + 1).replace(/\s+/g, "").length : 0;
    }
    if (/^https?:\/\//i.test(data)) return 0;
    return data.replace(/\s+/g, "").length;
  }
  if (data instanceof Uint8Array) {
    return Math.ceil(data.byteLength / 3) * 4;
  }
  if (data instanceof ArrayBuffer) {
    return Math.ceil(data.byteLength / 3) * 4;
  }
  if (isRecord(data) && data.type === "data") {
    return base64SizeOfImageData(data.data);
  }
  return 0;
}

function isHistoryImagePart(part: unknown): part is Record<string, unknown> {
  if (!isRecord(part)) return false;
  if (part.type === "image") return true;
  return (
    part.type === "file" &&
    typeof part.mediaType === "string" &&
    part.mediaType.startsWith("image/")
  );
}

function historyPartImageData(part: Record<string, unknown>): unknown {
  return part.type === "image" ? part.image : part.data;
}

/**
 * Sum of earlier user image/file parts, each capped at the per-image max.
 * History keeps the original inbound parts, including ones that were skipped
 * or sent to a harness without native image input, because persist does not
 * mark attached parts.
 */
export function conversationImageBase64Bytes(history: ModelMessage[]): number {
  let total = 0;
  for (const message of history) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isHistoryImagePart(part)) continue;
      const size = base64SizeOfImageData(historyPartImageData(part));
      total += Math.min(size, HARNESS_PROMPT_IMAGE_MAX_BASE64);
    }
  }
  return total;
}

async function encodePreferred(
  image: SharpPipeline,
  keepJpeg: boolean,
  edge: number,
): Promise<{ buffer: Buffer; mediaType: string }> {
  const resized = image.clone().resize({
    width: edge,
    height: edge,
    fit: "inside",
    withoutEnlargement: true,
  });
  if (keepJpeg) {
    return { buffer: await resized.jpeg().toBuffer(), mediaType: "image/jpeg" };
  }
  return { buffer: await resized.png().toBuffer(), mediaType: "image/png" };
}

async function encodeWebp(image: SharpPipeline, edge: number): Promise<Buffer> {
  return image
    .clone()
    .resize({
      width: edge,
      height: edge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 90 })
    .toBuffer();
}

async function resizeOne(
  bytes: Uint8Array,
  sharp: SharpFn,
): Promise<
  | { ok: true; buffer: Buffer; mediaType: string }
  | { ok: false; reason: string }
> {
  try {
    const image = sharp(Buffer.from(bytes), {
      limitInputPixels: HARNESS_PROMPT_IMAGE_MAX_PIXELS,
      failOn: "error",
      page: 0,
    }).rotate();
    const meta = await image.metadata();
    const keepJpeg = meta.format === "jpeg" || meta.format === "jpg";
    let encoded = await encodePreferred(
      image,
      keepJpeg,
      HARNESS_PROMPT_IMAGE_MAX_EDGE,
    );
    if (encoded.buffer.byteLength <= HARNESS_PROMPT_IMAGE_MAX_BYTES) {
      return { ok: true, buffer: encoded.buffer, mediaType: encoded.mediaType };
    }
    for (const edge of WEBP_EDGES) {
      const webp = await encodeWebp(image, edge);
      if (webp.byteLength <= HARNESS_PROMPT_IMAGE_MAX_BYTES) {
        return { ok: true, buffer: webp, mediaType: "image/webp" };
      }
    }
    return { ok: false, reason: TOO_LARGE };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/pixel/i.test(message)) return { ok: false, reason: TOO_MANY_PIXELS };
    return { ok: false, reason: UNREADABLE };
  }
}

function skipped(reason: string): HarnessPromptImage {
  return { status: "skipped", reason };
}

/** One result per attachment, in order. Never rejects. */
export async function prepareHarnessPromptImages(args: {
  attachments: HarnessPromptAttachment[];
  history: ModelMessage[];
  abortSignal?: AbortSignal;
}): Promise<HarnessPromptImage[]> {
  const results: HarnessPromptImage[] = [];
  const sharp = await sharpLibrary();
  const historyUsed = conversationImageBase64Bytes(args.history);
  let turnUsed = 0;
  const skipReasons: string[] = [];

  for (const attachment of args.attachments) {
    if (!isImageAttachment(attachment)) {
      results.push({ status: "not-image" });
      continue;
    }
    if (args.abortSignal?.aborted) {
      results.push(skipped(CANCELLED));
      skipReasons.push(CANCELLED);
      continue;
    }
    const decoded = attachment.decoded;
    if (!decoded || "error" in decoded) {
      const reason = decoded && "error" in decoded ? decoded.error : UNREADABLE;
      results.push(skipped(reason));
      skipReasons.push(reason);
      continue;
    }
    if (!isHarnessPromptRasterImage(decoded.bytes)) {
      results.push(skipped(NOT_RASTER));
      skipReasons.push(NOT_RASTER);
      continue;
    }
    if (!sharp) {
      results.push(skipped(LIBRARY_UNAVAILABLE));
      skipReasons.push(LIBRARY_UNAVAILABLE);
      continue;
    }
    const conversationAlready = historyUsed + turnUsed;
    if (conversationAlready >= HARNESS_PROMPT_IMAGE_CONVERSATION_BUDGET) {
      const reason = conversationBudgetReason(conversationAlready);
      results.push(skipped(reason));
      skipReasons.push(reason);
      continue;
    }
    if (turnUsed >= HARNESS_PROMPT_IMAGE_TURN_BUDGET) {
      results.push(skipped(TURN_FULL));
      skipReasons.push(TURN_FULL);
      continue;
    }
    const resized = await resizeOne(decoded.bytes, sharp);
    if (!resized.ok) {
      results.push(skipped(resized.reason));
      skipReasons.push(resized.reason);
      continue;
    }
    const base64 = resized.buffer.toString("base64");
    const base64Bytes = base64.length;
    if (turnUsed + base64Bytes > HARNESS_PROMPT_IMAGE_TURN_BUDGET) {
      results.push(skipped(TURN_FULL));
      skipReasons.push(TURN_FULL);
      continue;
    }
    if (
      historyUsed + turnUsed + base64Bytes >
      HARNESS_PROMPT_IMAGE_CONVERSATION_BUDGET
    ) {
      const reason = conversationBudgetReason(historyUsed + turnUsed);
      results.push(skipped(reason));
      skipReasons.push(reason);
      continue;
    }
    turnUsed += base64Bytes;
    results.push({
      status: "attached",
      part: {
        type: "image",
        image: base64,
        mediaType: resized.mediaType,
      },
      base64Bytes,
    });
  }

  const attached = results.filter((r) => r.status === "attached").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;
  logger.info("[harness] prompt images", {
    attached,
    skipped: skippedCount,
    attachedBase64Bytes: turnUsed,
    skipReasons,
  });
  return results;
}

/** The prompt with attached image parts after its text. New objects only. */
export function withHarnessPromptImages(
  messages: ModelMessage[],
  images: HarnessPromptImage[],
): ModelMessage[] {
  const attached = images.filter(
    (image): image is Extract<HarnessPromptImage, { status: "attached" }> =>
      image.status === "attached",
  );
  if (attached.length === 0) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : [...message.content];
    const next = [...messages];
    next[i] = {
      ...message,
      content: [...content, ...attached.map((image) => image.part)],
    } as ModelMessage;
    return next;
  }
  return messages;
}
