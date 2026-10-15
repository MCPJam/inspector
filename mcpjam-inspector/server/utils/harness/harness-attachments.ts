/**
 * Composer attachments on a harness turn: out of the prompt, onto the
 * session's own disk.
 *
 * A harness turn hands its adapter ONE user message (the last one,
 * `_resolvePromptTurnInput`), and no adapter can take a file part: Claude Code
 * throws on any non-text part, the ACP adapter (Cursor) throws on image and
 * file parts, and MCPJam's Codex app-server adapter drops them without a word.
 * So on every harness turn the file parts come OUT of that message before
 * `stream()`, their bytes are written into the session through the sandbox
 * file API, and a text note naming each saved path rides the prompt instead.
 * The agent opens them with its own file tools.
 *
 * Where they land:
 *   - hosted (the conversation's throwaway box, or a persistent computer):
 *     `/home/user/attachments`, the bucket the Playground's COMP-14 upload
 *     already used for computer hosts.
 *   - local (this machine): the session's private state directory, never the
 *     workspace. The workspace is the user's real checkout.
 *
 * Hygiene: basename only, control characters stripped, a uuid prefix, and the
 * count and size caps the computer upload route applies. Contents are never
 * logged. A file that can't be saved is NAMED in the note as such rather than
 * silently dropped.
 *
 * The inbound `messages` are never mutated: they are shared with the turn's
 * `messageHistory`, which persists the user message exactly as it was sent.
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { reserveUploadBytes } from "../computers/control-plane-client.js";
import { HOME_ROOT } from "../computers/path-confine.js";
import { logger } from "../logger.js";

/** Hosted landing bucket. Same path the COMP-14 composer upload wrote to. */
export const HOSTED_HARNESS_ATTACHMENTS_DIR = posix.join(
  HOME_ROOT,
  "attachments",
);

// The computer upload route's caps (`routes/web/computer-upload.ts`), so a file
// that would land through the Shell lands here too, and nothing larger does.
export const HARNESS_ATTACHMENTS_MAX_FILES = 20;
export const HARNESS_ATTACHMENTS_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const HARNESS_ATTACHMENTS_MAX_TOTAL_BYTES = 30 * 1024 * 1024;

/** Longest cleaned filename kept (the uuid prefix comes on top). */
const MAX_NAME_LENGTH = 120;

export interface HarnessPromptAttachment {
  /** The user's filename, cleaned for display: no path, no control chars. */
  name: string;
  /** `<uuid>-<safe basename>`, chosen once so a retried write overwrites. */
  fileName: string;
  /** The part's raw `data` (data URL, base64 or bytes), decoded at write. */
  data: unknown;
}

export type HarnessAttachmentOutcome =
  { name: string; path: string } | { name: string; error: string };

/** The narrow file API this needs from the restricted sandbox session. */
export interface HarnessAttachmentSession {
  writeBinaryFile(args: {
    path: string;
    content: Uint8Array;
    abortSignal?: AbortSignal;
  }): PromiseLike<unknown>;
}

// C0 controls, DEL and the C1 range. A newline in a name would let it forge a
// second line of the note.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** The last path segment of a name, whichever separator its OS used. */
function lastSegment(raw: string): string {
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** A name for the note: the user's own, minus any path and control chars. */
function displayName(raw: unknown, fallback: string): string {
  const base =
    typeof raw === "string"
      ? lastSegment(raw).replace(CONTROL_CHARS, "").trim()
      : "";
  if (!base || base === "." || base === "..") return fallback;
  return base.length > MAX_NAME_LENGTH ? base.slice(0, MAX_NAME_LENGTH) : base;
}

/**
 * The on-disk basename: the display name with anything outside a small safe
 * set replaced, never `.`/`..`/empty, and a uuid in front so it can't clobber
 * a file the agent wrote or collide with an earlier attachment.
 */
export function safeHarnessAttachmentName(name: string): string {
  let cleaned = lastSegment(name)
    .replace(CONTROL_CHARS, "")
    .replace(/[^\w.\- ]/g, "_")
    .trim();
  if (cleaned.length > MAX_NAME_LENGTH) {
    // Keep the extension: it is how the agent knows what it is opening.
    const dot = cleaned.lastIndexOf(".");
    const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  const safe =
    cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
  return `${randomUUID()}-${safe}`;
}

function fallbackName(mediaType: unknown, index: number): string {
  const subtype =
    typeof mediaType === "string" ? (mediaType.split("/")[1] ?? "") : "";
  const ext = /^[a-z0-9]{1,8}$/i.test(subtype) ? `.${subtype}` : "";
  return `attachment-${index + 1}${ext}`;
}

/**
 * Split the prompt (the LAST user message, the only one a harness reads) into
 * its text and its attachments. Returns a NEW messages array whose last user
 * message carries text parts only, and leaves the input untouched. With no
 * non-text part to remove, the input array comes back as is.
 */
export function takeHarnessPromptAttachments(messages: ModelMessage[]): {
  messages: ModelMessage[];
  attachments: HarnessPromptAttachment[];
} {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      index = i;
      break;
    }
  }
  const prompt = index >= 0 ? messages[index] : undefined;
  if (!prompt || !Array.isArray(prompt.content)) {
    return { messages, attachments: [] };
  }

  const attachments: HarnessPromptAttachment[] = [];
  const text: unknown[] = [];
  let dropped = 0;
  for (const part of prompt.content as unknown[]) {
    const record =
      part && typeof part === "object" ? (part as Record<string, unknown>) : {};
    if (record.type === "text") {
      text.push(part);
      continue;
    }
    if (record.type === "file" || record.type === "image") {
      const name = displayName(
        record.filename,
        fallbackName(record.mediaType, attachments.length),
      );
      attachments.push({
        name,
        fileName: safeHarnessAttachmentName(name),
        data: record.type === "image" ? record.image : record.data,
      });
      continue;
    }
    // Any other non-text part: no adapter takes one either.
    dropped += 1;
  }
  if (attachments.length === 0 && dropped === 0) {
    return { messages, attachments };
  }
  const next = [...messages];
  next[index] = { ...prompt, content: text } as ModelMessage;
  return { messages: next, attachments };
}

type DecodedAttachment = { bytes: Uint8Array } | { error: string };

const MB = 1024 * 1024;

function overLimit(bytes: number, remaining: number): string | null {
  if (bytes > HARNESS_ATTACHMENTS_MAX_FILE_BYTES) {
    return `over the ${HARNESS_ATTACHMENTS_MAX_FILE_BYTES / MB} MB per-file limit`;
  }
  if (bytes > remaining) {
    return `over the ${HARNESS_ATTACHMENTS_MAX_TOTAL_BYTES / MB} MB total limit`;
  }
  return null;
}

/** Decode base64 after checking its decoded size, so a huge string is
 *  refused before it is ever expanded. */
function decodeBase64(b64: string, remaining: number): DecodedAttachment {
  const body = b64.replace(/\s+/g, "");
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  const estimate = Math.max(0, Math.floor((body.length * 3) / 4) - padding);
  const limit = overLimit(estimate, remaining);
  if (limit) return { error: limit };
  return { bytes: new Uint8Array(Buffer.from(body, "base64")) };
}

function decodeDataUrl(url: string, remaining: number): DecodedAttachment {
  const comma = url.indexOf(",");
  if (comma < 0) return { error: "it was not readable" };
  const meta = url.slice("data:".length, comma);
  const payload = url.slice(comma + 1);
  if (/;base64$/i.test(meta)) return decodeBase64(payload, remaining);
  // Every three payload characters decode to at least one byte, so a payload
  // that long is refused before decodeURIComponent expands it.
  const floor = overLimit(Math.ceil(payload.length / 3), remaining);
  if (floor) return { error: floor };
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return { error: "it was not readable" };
  }
  const limit = overLimit(bytes.byteLength, remaining);
  return limit ? { error: limit } : { bytes };
}

/**
 * The part's bytes, from any shape the AI SDK carries file data in. A remote
 * URL is NOT fetched: the server reaching out to a user-supplied address on
 * the user's behalf is a different feature, so it is reported instead.
 */
function decodeAttachmentData(
  data: unknown,
  remaining: number,
): DecodedAttachment {
  if (typeof data === "string") {
    if (/^data:/i.test(data)) return decodeDataUrl(data, remaining);
    if (/^https?:\/\//i.test(data)) {
      return { error: "it was sent as a link, not as file content" };
    }
    return decodeBase64(data, remaining);
  }
  if (data instanceof URL) {
    return data.protocol === "data:"
      ? decodeDataUrl(data.href, remaining)
      : { error: "it was sent as a link, not as file content" };
  }
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const limit = overLimit(bytes.byteLength, remaining);
    return limit ? { error: limit } : { bytes };
  }
  // AI SDK 7's tagged file data.
  if (data && typeof data === "object") {
    const tagged = data as {
      type?: unknown;
      data?: unknown;
      url?: unknown;
      text?: unknown;
    };
    if (tagged.type === "data")
      return decodeAttachmentData(tagged.data, remaining);
    if (tagged.type === "url")
      return decodeAttachmentData(tagged.url, remaining);
    if (tagged.type === "text" && typeof tagged.text === "string") {
      const bytes = new TextEncoder().encode(tagged.text);
      const limit = overLimit(bytes.byteLength, remaining);
      return limit ? { error: limit } : { bytes };
    }
  }
  return { error: "it was not readable" };
}

/** A native Windows directory keeps its own separator in the note. */
function joinAgentPath(dir: string, fileName: string): string {
  return dir.includes("\\") && !dir.includes("/")
    ? `${dir.replace(/\\+$/, "")}\\${fileName}`
    : posix.join(dir, fileName);
}

/**
 * Write each attachment under `dir` through the session's file API. Never
 * throws: a file that can't be written comes back as an `error` outcome so the
 * note can say so. `agentDir` is the spelling the AGENT should read (it differs
 * from `dir` only for a local Windows session, where the file API takes the
 * adapter's POSIX spelling). `reserveBytes` charges a persistent computer's
 * storage quota first; `false` means over quota.
 */
export async function saveHarnessAttachments(args: {
  session: HarnessAttachmentSession;
  dir: string;
  agentDir?: string;
  attachments: HarnessPromptAttachment[];
  reserveBytes?: (bytes: number) => Promise<boolean>;
  abortSignal?: AbortSignal;
}): Promise<HarnessAttachmentOutcome[]> {
  const outcomes: HarnessAttachmentOutcome[] = [];
  let remaining = HARNESS_ATTACHMENTS_MAX_TOTAL_BYTES;
  let savedBytes = 0;
  for (const [index, attachment] of args.attachments.entries()) {
    const { name } = attachment;
    if (index >= HARNESS_ATTACHMENTS_MAX_FILES) {
      outcomes.push({
        name,
        error: `over the ${HARNESS_ATTACHMENTS_MAX_FILES}-file limit`,
      });
      continue;
    }
    const decoded = decodeAttachmentData(attachment.data, remaining);
    if ("error" in decoded) {
      outcomes.push({ name, error: decoded.error });
      continue;
    }
    const { bytes } = decoded;
    try {
      if (args.reserveBytes && !(await args.reserveBytes(bytes.byteLength))) {
        outcomes.push({ name, error: "over this computer's storage quota" });
        continue;
      }
      await args.session.writeBinaryFile({
        path: posix.join(args.dir, attachment.fileName),
        content: bytes,
        ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      });
    } catch (error) {
      // The error, never the bytes.
      logger.warn("[harness] attachment write failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      outcomes.push({ name, error: "the write failed" });
      continue;
    }
    remaining -= bytes.byteLength;
    savedBytes += bytes.byteLength;
    outcomes.push({
      name,
      path: joinAgentPath(args.agentDir ?? args.dir, attachment.fileName),
    });
  }
  const saved = outcomes.filter((o) => "path" in o).length;
  logger.info("[harness] attachments saved", {
    saved,
    failed: outcomes.length - saved,
    savedBytes,
  });
  return outcomes;
}

/**
 * `reserveBytes` for a PERSISTENT computer: the COMP-8 cumulative quota the
 * upload route charged before these files went through it. Only a 413 refuses;
 * an unreachable control plane allows the write, as `materialize-skill-files`
 * does. A throwaway box has no quota row and passes no reserver.
 */
export function computerQuotaReserver(
  computerId: string,
): (bytes: number) => Promise<boolean> {
  return async (bytes) => {
    const reservation = await reserveUploadBytes({ computerId, bytes });
    return reservation.ok || reservation.status !== 413;
  };
}

/** Every attachment as not saved: the session never reached the write. */
export function unsavedHarnessAttachments(
  attachments: HarnessPromptAttachment[],
): HarnessAttachmentOutcome[] {
  return attachments.map(({ name }) => ({
    name,
    error: "the session never started",
  }));
}

/**
 * The model-visible note. Same line shape as the COMP-14 note
 * (`client/src/lib/computer-attachments.ts`), so the model can quote paths
 * verbatim, but it names the agent's file tools rather than `bash`: Claude
 * Code's `Read` opens images and PDFs natively.
 */
export function buildHarnessAttachmentNote(
  outcomes: HarnessAttachmentOutcome[],
): string {
  if (outcomes.length === 0) return "";
  const anySaved = outcomes.some((o) => "path" in o);
  const lines = outcomes.map((o) =>
    "path" in o
      ? `- ${o.name}: ${o.path}`
      : `- ${o.name}: couldn't be saved (${o.error})`,
  );
  return [
    anySaved
      ? "[Attachments uploaded to the computer: use your file tools to read them]"
      : "[Attachments the user sent that couldn't be saved to the computer]",
    ...lines,
  ].join("\n");
}

/**
 * The note as one more text part at the end of the last user message (both
 * text-joining adapters put a blank line between parts). New objects only.
 */
export function withHarnessAttachmentNote(
  messages: ModelMessage[],
  note: string,
): ModelMessage[] {
  if (!note) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    const next = [...messages];
    next[i] = {
      ...message,
      content: [...content, { type: "text", text: note }],
    } as ModelMessage;
    return next;
  }
  return messages;
}
