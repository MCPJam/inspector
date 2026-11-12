/**
 * Put a harness CLI's saved session files back on a REPLACED box, so the turn
 * resumes the CLI natively instead of starting blank (`save-session-snapshot`
 * is the other half).
 *
 * The download starts as soon as the turn knows its box was replaced, before
 * the broker and the runtime start, so it overlaps the cold start that turn
 * pays anyway. The files are written from `onSandboxSession`, which runs before
 * the CLI does. Any failure leaves the turn exactly where it was without this:
 * a fresh session and the existing reset notice.
 */
import { logger } from "../../logger.js";
import {
  getHarnessResumeEligibility,
  postSessionState,
  type HarnessOwnerRef,
  type HarnessResumePayload,
} from "../harness-session-state.js";
import {
  boxHome,
  decodeSnapshot,
  writeSessionFiles,
  type SnapshotFileSession,
} from "./snapshot-bundle.js";
import { sessionFileSpec } from "./session-files.js";

/** The backend's own ceiling on a stored snapshot, plus room for headers. */
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024 + 64 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const RESTORABLE = new Set(["claude-code", "codex"]);

/** What the model is told on the first prompt of a restored session. */
export const SESSION_RESTORED_NOTE =
  "This conversation's computer was replaced since your last turn. Your " +
  "conversation history is intact, but files, installed tools and shell state " +
  "from earlier turns are gone. Check before relying on them.";

export type SessionSnapshotRestore = {
  /**
   * Wait for the download. True when a snapshot for this exact session is in
   * hand; the next `apply` then writes it.
   */
  ready(): Promise<boolean>;
  /** Write the files onto the box. Runs once; throws when they cannot land. */
  apply(session: SnapshotFileSession, workDir: string): Promise<void>;
};

async function download(args: {
  owner: HarnessOwnerRef;
  state: HarnessResumePayload;
  stateVersion: number;
  bearer: string;
}): Promise<Uint8Array | null> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const read = await postSessionState(
    "snapshot/read",
    args.bearer,
    {
      ...args.owner,
      harnessSessionId: args.state.harnessSessionId,
      stateVersion: args.stateVersion,
    },
    signal,
  );
  const url = read.ok ? read.payload?.snapshot?.url : undefined;
  if (typeof url !== "string") return null;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.byteLength <= MAX_DOWNLOAD_BYTES ? bytes : null;
}

/**
 * Start fetching the saved session when this turn's box replaced the one the
 * session was saved on. Undefined when there is nothing to restore: the box
 * survived, no session was committed, or the turn is one this does not cover.
 */
export function startSessionSnapshotRestore(args: {
  hosted: boolean;
  owner: HarnessOwnerRef | undefined;
  state: HarnessResumePayload | null | undefined;
  stateVersion: number | undefined;
  computerId: string;
  sandboxId: string | null;
  getBearer: () => Promise<string>;
}): SessionSnapshotRestore | undefined {
  const { owner, state, stateVersion, sandboxId } = args;
  if (
    !args.hosted ||
    !owner ||
    owner.executionScope ||
    !state ||
    state.awaitingApproval ||
    stateVersion === undefined ||
    !sandboxId ||
    !RESTORABLE.has(owner.harnessId) ||
    getHarnessResumeEligibility({
      state,
      computerId: args.computerId,
      sandboxId,
    }).reason !== "sandbox-replaced"
  ) {
    return undefined;
  }
  const startedAt = Date.now();
  const fetched = args
    .getBearer()
    .then((bearer) => download({ owner, state, stateVersion, bearer }))
    .catch((error: unknown) => {
      logger.warn("[harness][snapshot] restore download failed", {
        harnessId: owner.harnessId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  let armed: Uint8Array | null = null;
  return {
    async ready() {
      armed = await fetched;
      logger.info(
        `[harness][snapshot] restore ${armed ? "available" : "missing"} after ${Date.now() - startedAt}ms`,
        { harnessId: owner.harnessId },
      );
      return armed !== null;
    },
    async apply(session, workDir) {
      const bytes = armed;
      armed = null;
      if (!bytes) return;
      const home = await boxHome(session);
      const spec = sessionFileSpec({
        harnessId: owner.harnessId,
        harnessSessionId: state.harnessSessionId,
        resumeState: state.resumeState,
        home,
      });
      if (!spec) throw new Error("This session cannot be restored here.");
      const bundle = decodeSnapshot(bytes, {
        spec,
        home,
        harnessSessionId: state.harnessSessionId,
      });
      // Claude Code files its transcript by working folder: another folder
      // would resume nothing.
      if (bundle.workDir && bundle.workDir !== workDir) {
        throw new Error("The saved session belongs to another working folder.");
      }
      await writeSessionFiles({ session, home, files: bundle.files });
      logger.info(
        `[harness][snapshot] restored ${bundle.files.length} files after ${Date.now() - startedAt}ms`,
        { harnessId: owner.harnessId },
      );
    },
  };
}
