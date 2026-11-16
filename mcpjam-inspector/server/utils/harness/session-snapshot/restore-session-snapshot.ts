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
 *
 * The backend serves a copy once, so a CLI that cannot resume from it costs
 * one turn, not every turn after it.
 */
import { logger } from "../../logger.js";
import {
  getConvexHttpUrl,
  getHarnessResumeEligibility,
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
/** Runtimes whose files this knows how to place; the backend decides which it serves. */
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

/** The snapshot's bytes, or null when the backend has none to serve. */
async function download(args: {
  owner: HarnessOwnerRef;
  state: HarnessResumePayload;
  stateVersion: number;
  bearer: string;
  signal: AbortSignal;
}): Promise<Uint8Array | null> {
  const res = await fetch(
    new URL("/web/harness/session-state/snapshot/read", getConvexHttpUrl()),
    {
      method: "POST",
      headers: {
        authorization: args.bearer.startsWith("Bearer ")
          ? args.bearer
          : `Bearer ${args.bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...args.owner,
        harnessSessionId: args.state.harnessSessionId,
        stateVersion: args.stateVersion,
      }),
      signal: args.signal,
    },
  );
  if (
    res.status !== 200 ||
    res.headers.get("content-type") !== "application/gzip"
  ) {
    return null;
  }
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
  /** The turn's own signal: a cancelled turn stops waiting at once. */
  abortSignal?: AbortSignal;
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
  const signal = args.abortSignal
    ? AbortSignal.any([
        args.abortSignal,
        AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ])
    : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const fetched = args
    .getBearer()
    .then((bearer) => download({ owner, state, stateVersion, bearer, signal }))
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
      const stopped = new Promise<null>((resolve) => {
        if (signal.aborted) resolve(null);
        else
          signal.addEventListener("abort", () => resolve(null), { once: true });
      });
      armed = await Promise.race([fetched, stopped]);
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
      // The turn's own signal only: the download timeout would cut off a box
      // whose cold start outlasted it.
      const turnSignal = args.abortSignal;
      const home = await boxHome(session, turnSignal);
      const spec = sessionFileSpec({
        harnessId: owner.harnessId,
        harnessSessionId: state.harnessSessionId,
        resumeState: state.resumeState,
        home,
      });
      if (!spec) throw new Error("This session cannot be restored here.");
      const bundle = await decodeSnapshot(bytes, {
        spec,
        home,
        harnessSessionId: state.harnessSessionId,
      });
      // Claude Code files its transcript by working folder: another folder
      // would resume nothing.
      if (bundle.workDir && bundle.workDir !== workDir) {
        throw new Error("The saved session belongs to another working folder.");
      }
      await writeSessionFiles({
        session,
        home,
        files: bundle.files,
        ...(turnSignal ? { abortSignal: turnSignal } : {}),
      });
      logger.info(
        `[harness][snapshot] restored ${bundle.files.length} files after ${Date.now() - startedAt}ms`,
        { harnessId: owner.harnessId },
      );
    },
  };
}
