/**
 * Chat attachments → the attached computer's filesystem (COMP-14).
 *
 * When a host config attaches a personal computer, files the user attaches in
 * the chat composer are ALSO uploaded into the sandbox (under
 * `COMPUTER_ATTACHMENTS_DIR`) so the model's `bash` tool — and any MCP server
 * running against the box — can actually reach them. Inline file parts alone
 * are invisible to bash (they ride the prompt as data URLs), and the harness
 * prompt channel is text-only, so the sandbox path note appended to the message
 * text is the one channel that works on BOTH engines.
 *
 * This module is the pure core: the upload orchestration (reserve → mint →
 * upload, deps injected for tests) and the model-visible note builder. React
 * wiring lives in `hooks/useComputerAttachmentUpload.ts`.
 *
 * The upload rides the existing `POST /api/web/computers/upload` route, which
 * already enforces the COMP-8 cumulative-upload quota (`reserveUploadBytes`
 * server-side), the 30 MB request caps, and `/home/user` path confinement — no
 * second writer path is introduced here.
 */

import {
  uploadFilesToComputer,
  type UploadedComputerFile,
} from "./computer-terminal-connection";

/** Predictable landing bucket for chat attachments — distinct from the Shell's
 *  drag-drop default (`/home/user/uploads`) so "files I attached in chat" are
 *  recognizable at a glance. The server confines it under `/home/user`. */
export const COMPUTER_ATTACHMENTS_DIR = "/home/user/attachments";

export interface ComputerAttachmentNoteEntry {
  /** The user's original filename (what they'll recognize in the transcript). */
  name: string;
  /** Absolute sandbox path the server actually wrote (UUID-prefixed basename). */
  path: string;
}

/**
 * The system-visible note appended to the outgoing user message. Visible in the
 * transcript AND model-visible on both engines (the harness collapses a turn to
 * the last user message's TEXT, so a text suffix is the only cross-engine
 * channel). Kept terse and line-oriented so the model can quote paths verbatim.
 */
export function buildComputerAttachmentNote(
  entries: ComputerAttachmentNoteEntry[],
): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `- ${e.name}: ${e.path}`);
  return [
    "[Attachments uploaded to the computer — use the bash tool to read them]",
    ...lines,
  ].join("\n");
}

/** Pair the user's original filenames with the server-written sandbox paths.
 *  The upload route writes (and returns) files in request order; fall back to
 *  the server-reported name if the arrays ever disagree in length. */
export function zipAttachmentNoteEntries(
  originalNames: string[],
  uploaded: UploadedComputerFile[],
): ComputerAttachmentNoteEntry[] {
  return uploaded.map((file, i) => ({
    name: originalNames[i] ?? file.name,
    path: file.path,
  }));
}

export interface ComputerAttachmentUploadDeps {
  /** Convex `projectComputers:getOrReserveComputer` — provision-on-first-use /
   *  wake. THE reservation path (COMP-14 explicitly forbids a second one). */
  reserve: (args: { projectId: string }) => Promise<unknown>;
  /** Convex `projectComputers:mintTerminalToken` — ~60s data-plane token. */
  mintToken: (args: { projectId: string }) => Promise<{ token: string }>;
  /** The shared upload client (injectable for tests). */
  upload?: typeof uploadFilesToComputer;
}

/**
 * Reserve/wake the caller's computer, mint a fresh terminal token, and upload
 * the composer's files into `COMPUTER_ATTACHMENTS_DIR`. Ordering matters:
 * reserve FIRST (creates the row on first use; wakes a hibernating box) so the
 * mint has a computer to bind to; `Sandbox.connect` on the server side
 * auto-resumes a paused box, so only a still-provisioning fresh machine can
 * fail afterwards (surfaced as the route's friendly 503 message).
 *
 * Throws with a user-presentable message on any failure — callers abort the
 * send and keep the composer state intact (no silent drop of the user's
 * attachments or text).
 */
export async function uploadAttachmentsToComputer(
  deps: ComputerAttachmentUploadDeps,
  args: {
    projectId: string;
    files: File[];
    /** ws(s):// base of the remote data plane, when this inspector doesn't
     *  host the sandbox itself (same resolution the Shell uses). */
    uploadBaseUrl?: string;
  },
): Promise<ComputerAttachmentNoteEntry[]> {
  if (args.files.length === 0) return [];
  await deps.reserve({ projectId: args.projectId });
  const { token } = await deps.mintToken({ projectId: args.projectId });
  const upload = deps.upload ?? uploadFilesToComputer;
  const uploaded = await upload({
    token,
    files: args.files,
    dir: COMPUTER_ATTACHMENTS_DIR,
    ...(args.uploadBaseUrl ? { baseUrl: args.uploadBaseUrl } : {}),
  });
  return zipAttachmentNoteEntries(
    args.files.map((f) => f.name),
    uploaded,
  );
}
