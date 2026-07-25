/**
 * COMP-17 — seed an eval iteration's fresh ephemeral sandbox with the case's
 * attachments.
 *
 * Evals deliberately run on a fresh per-iteration sandbox (no personal
 * computer), so a case's attachments must be re-materialized into the box every
 * iteration to stay reproducible. The bytes live in Convex `_storage`, pinned by
 * content-hash into the run's `configSnapshot` at run start (mcpjam-backend
 * `testSuites.ts`); here we resolve those pins to short-lived download URLs
 * (`/evals/sandbox/attachments`) and write each file to its frozen path inside
 * the box via the E2B file API.
 *
 * Fail-honest (design §5): if anything prevents a file from landing — the pin
 * vanished (`url: null`), a download fails, a cap is exceeded, or the write
 * throws — this REJECTS so the caller fails the iteration. An eval that answers
 * "how many rows?" without its CSV looks like a passing result; a hard failure
 * is strictly better. Mirrors the tri-state skill-file contract (never treat a
 * fetch failure as "no files").
 */
import { Sandbox } from "e2b";
import {
  resolveEvalRunAttachments,
  type ResolvedEvalAttachment,
} from "./control-plane-client.js";
import { logger } from "../logger.js";

// Re-checked here even though authoring already enforced them: the snapshot is
// the source of truth at seed time, and seeding many sandboxes in bursts is real
// E2B bandwidth. Kept in sync with the backend constants (testSuites.ts).
const EVAL_ATTACHMENTS_MAX_COUNT = 20;
const EVAL_ATTACHMENTS_MAX_TOTAL_BYTES = 30 * 1024 * 1024;

/** Injectable so tests exercise the fetch→write pipeline without an E2B account. */
export type AttachmentSeedWriter = (args: {
  sandboxId: string;
  files: Array<{ path: string; bytes: Uint8Array }>;
}) => Promise<void>;

/** Default writer — real E2B `files.write`, one dir-create + write per file. */
export const e2bAttachmentSeedWriter: AttachmentSeedWriter = async ({
  sandboxId,
  files,
}) => {
  const sandbox = await Sandbox.connect(sandboxId);
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const dir = slash > 0 ? file.path.slice(0, slash) : "";
    if (dir) {
      // Idempotent + best-effort: a failure here surfaces as the write's own
      // error. The path is confined under /home/user by the backend.
      try {
        await sandbox.files.makeDir(dir);
      } catch {}
    }
    await sandbox.files.write(file.path, file.bytes);
  }
};

/**
 * Download each pinned attachment and write it into the sandbox at its frozen
 * path. Rejects (fail-honest) on a missing pin, a failed download, an exceeded
 * cap, or a write error — never seeds a partial set silently.
 */
export async function seedAttachmentsIntoSandbox(args: {
  sandboxId: string;
  attachments: ResolvedEvalAttachment[];
  signal?: AbortSignal;
  writer?: AttachmentSeedWriter;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { sandboxId, attachments, signal } = args;
  if (attachments.length === 0) return;
  if (attachments.length > EVAL_ATTACHMENTS_MAX_COUNT) {
    throw new Error(
      `This eval case has ${attachments.length} attachments, over the limit of ${EVAL_ATTACHMENTS_MAX_COUNT}.`
    );
  }
  const fetchImpl = args.fetchImpl ?? fetch;
  const writer = args.writer ?? e2bAttachmentSeedWriter;

  let totalBytes = 0;
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const att of attachments) {
    if (!att.url) {
      // The pinned blob is gone (deleted / snapshot missing). Fail rather than
      // run the case without a file it was authored to rely on.
      throw new Error(
        `Attachment "${att.name}" is no longer available (its pinned content could not be resolved) — failing the iteration instead of running without it.`
      );
    }
    totalBytes += att.size;
    if (totalBytes > EVAL_ATTACHMENTS_MAX_TOTAL_BYTES) {
      throw new Error(
        `This eval case's attachments exceed the ${Math.round(
          EVAL_ATTACHMENTS_MAX_TOTAL_BYTES / (1024 * 1024)
        )} MB per-case limit.`
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(att.url, signal ? { signal } : undefined);
    } catch (err) {
      logger.error(`[evals] attachment download failed: ${att.name}`, err);
      throw new Error(`Failed to download attachment "${att.name}".`);
    }
    if (!response.ok) {
      throw new Error(
        `Failed to download attachment "${att.name}" (${response.status}).`
      );
    }
    files.push({
      path: att.path,
      bytes: new Uint8Array(await response.arrayBuffer()),
    });
  }

  await writer({ sandboxId, files });
}

/**
 * The COMP-14 note appended to the case's first user turn so the model reaches
 * the seeded files the same way it would in chat. `null` when there's nothing to
 * announce.
 */
export function buildAttachmentsNote(
  attachments: ResolvedEvalAttachment[]
): string | null {
  if (attachments.length === 0) return null;
  const lines = attachments.map((att) => `- ${att.name}: ${att.path}`);
  return `[Attachments uploaded to the computer — use the bash tool to read them]\n${lines.join(
    "\n"
  )}`;
}

/**
 * Resolve → seed → note, for one iteration's case. Called between
 * `provisionEvalSandbox` and `buildEvalBashTool`: the box is fresh and nothing
 * runs before the files land. Matches the iteration's case by `testCaseId`
 * against the run's frozen snapshot. Returns the note to append (or `null` when
 * the case has no attachments); REJECTS if seeding fails (fail-honest).
 */
export async function seedEvalCaseAttachments(args: {
  bearer: string;
  runId: string;
  testCaseId: string | undefined;
  sandboxId: string;
  signal?: AbortSignal;
  resolver?: typeof resolveEvalRunAttachments;
  writer?: AttachmentSeedWriter;
  fetchImpl?: typeof fetch;
}): Promise<{ note: string | null }> {
  const resolver = args.resolver ?? resolveEvalRunAttachments;
  const resolved = await resolver({
    bearer: args.bearer,
    runId: args.runId,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!resolved.ok) {
    throw new Error(
      `Could not resolve this eval's attachments: ${resolved.error}`
    );
  }

  // Match this iteration's case by its frozen id. A case with no attachments
  // (or no id match — every case is emitted, so a miss means id drift) simply
  // seeds nothing; the common no-attachment path costs one cheap query.
  const match = args.testCaseId
    ? resolved.value.cases.find((c) => c.testCaseId === args.testCaseId)
    : undefined;
  const attachments = match?.attachments ?? [];
  if (attachments.length === 0) return { note: null };

  await seedAttachmentsIntoSandbox({
    sandboxId: args.sandboxId,
    attachments,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.writer ? { writer: args.writer } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });

  return { note: buildAttachmentsNote(attachments) };
}
