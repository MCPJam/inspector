/**
 * Reading a user-research file into the Describe box.
 *
 * Client-side only: the file's text lands in the same textarea, under the same
 * `SWARM_DESCRIPTION_MAX_CHARS` counter, so an attachment is exactly as costly
 * as pasting it. Nothing is uploaded.
 */

/** For the file picker's `accept`. Extensions carry `.md`, whose MIME type
 * browsers report inconsistently (often empty). */
export const DESCRIBE_ATTACHMENT_ACCEPT =
  ".txt,.md,.markdown,text/plain,text/markdown";

const ACCEPTED_EXTENSIONS = [".txt", ".md", ".markdown"];

/** Refuse before reading. Far above anything that fits the character cap, so
 * it only stops a mis-picked binary from being read into memory. */
export const DESCRIBE_ATTACHMENT_MAX_BYTES = 1024 * 1024;

export type DescribeAttachmentResult =
  { ok: true; text: string } | { ok: false; error: string };

export async function readDescribeAttachment(
  file: File,
): Promise<DescribeAttachmentResult> {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return { ok: false, error: "Only .txt and .md files are supported." };
  }
  if (file.size > DESCRIBE_ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: `${file.name} is larger than 1 MB.` };
  }
  const text = (await file.text()).trim();
  if (!text) {
    return { ok: false, error: `${file.name} is empty.` };
  }
  return { ok: true, text };
}

/** Appends rather than replaces, so a file can add to what was typed. */
export function appendToDraft(draft: string, text: string): string {
  const current = draft.trimEnd();
  return current ? `${current}\n\n${text}` : text;
}
