/**
 * Save a harness CLI's session files off the box after a turn, so a later turn
 * on a REPLACED box can put them back and resume natively.
 *
 * Runs after the turn's transcript and resume state are saved, and nothing
 * waits for it: the user's turn is already over. Every failure ends the save
 * and is logged; a missing snapshot only means the next replaced box starts
 * blank, as it did before. The backend decides whether snapshots are on
 * (`snapshot/upload-url` answers `enabled: false` otherwise).
 */
import { logger } from "../../logger.js";
import {
  createSecretScrubber,
  type SecretRegistryEntry,
} from "../../secrets/secret-scrubber.js";
import {
  postSessionState,
  type HarnessOwnerRef,
} from "../harness-session-state.js";
import {
  SnapshotTooLargeError,
  boxHome,
  collectSessionFiles,
  encodeSnapshot,
  type SnapshotFileSession,
} from "./snapshot-bundle.js";
import { sessionFileSpec } from "./session-files.js";

/** Long enough for a slow box and a large upload; short enough to never pile up. */
const SAVE_TIMEOUT_MS = 60_000;

export type SnapshotSaveOutcome =
  | "saved"
  | "unsupported"
  | "refused"
  | "empty"
  | "too-large"
  | "failed";

export type SaveSessionSnapshotArgs = {
  session: SnapshotFileSession;
  owner: HarnessOwnerRef;
  bearer: string;
  harnessSessionId: string;
  /** The lane version the turn's commit produced. */
  stateVersion: number;
  /** The runtime's own resume state, as `detach()` returned it. */
  resumeState: unknown;
  workDir?: string;
  /** Exactly the materialized secrets this turn delivered. */
  secrets: readonly SecretRegistryEntry[];
};

type UploadGrant = {
  uploadUrl: string;
  key: string;
  contentType: string;
  maxBytes: number;
};

function uploadGrant(payload: unknown): UploadGrant | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const read = (name: string) => Reflect.get(payload, name);
  const [uploadUrl, key, contentType, maxBytes] = [
    "uploadUrl",
    "key",
    "contentType",
    "maxBytes",
  ].map(read);
  return read("enabled") === true &&
    typeof uploadUrl === "string" &&
    typeof key === "string" &&
    typeof contentType === "string" &&
    typeof maxBytes === "number"
    ? { uploadUrl, key, contentType, maxBytes }
    : undefined;
}

export async function saveSessionSnapshot(
  args: SaveSessionSnapshotArgs,
): Promise<SnapshotSaveOutcome> {
  const signal = AbortSignal.timeout(SAVE_TIMEOUT_MS);
  const session = {
    harnessSessionId: args.harnessSessionId,
    stateVersion: args.stateVersion,
  };
  const begun = await postSessionState(
    "snapshot/upload-url",
    args.bearer,
    { ...args.owner, ...session },
    signal,
  );
  const grant = begun.ok ? uploadGrant(begun.payload) : undefined;
  if (!grant) return "refused";

  const home = await boxHome(args.session, signal);
  const spec = sessionFileSpec({
    harnessId: args.owner.harnessId,
    harnessSessionId: args.harnessSessionId,
    resumeState: args.resumeState,
    home,
  });
  if (!spec) return "unsupported";
  let files;
  try {
    files = await collectSessionFiles({
      session: args.session,
      spec,
      home,
      scrubber: createSecretScrubber(args.secrets),
      abortSignal: signal,
    });
  } catch (error) {
    if (error instanceof SnapshotTooLargeError) return "too-large";
    throw error;
  }
  if (files.length === 0) return "empty";
  const bytes = encodeSnapshot({
    version: 1,
    harnessId: spec.harnessId,
    harnessSessionId: args.harnessSessionId,
    ...(args.workDir ? { workDir: args.workDir } : {}),
    files,
  });
  if (bytes.byteLength > grant.maxBytes) return "too-large";

  const upload = await fetch(grant.uploadUrl, {
    method: "POST",
    headers: { "content-type": grant.contentType },
    body: new Uint8Array(bytes),
    signal,
  });
  const uploaded: unknown = upload.ok ? await upload.json() : undefined;
  const storageId =
    uploaded && typeof uploaded === "object"
      ? Reflect.get(uploaded, "storageId")
      : undefined;
  if (typeof storageId !== "string") return "failed";

  const committed = await postSessionState(
    "snapshot/commit",
    args.bearer,
    {
      ...args.owner,
      key: grant.key,
      storageId,
    },
    signal,
  );
  return committed.ok && committed.payload?.saved === true
    ? "saved"
    : "refused";
}

/**
 * The save a hosted turn runs once its commit lands, or undefined when this
 * turn's session is not one to save:
 *
 *   - a local runtime keeps its session on the user's own machine;
 *   - a guest (execution-scope) lane and the warm-agent pilot are out of scope;
 *   - `secrets` undefined means the turn could not tell which materialized
 *     secrets the box holds, so nothing could be scrubbed with confidence.
 */
export function sessionSnapshotSaver(
  args: Omit<SaveSessionSnapshotArgs, "bearer" | "session" | "secrets"> & {
    hosted: boolean;
    session: SnapshotFileSession | undefined;
    secrets: readonly SecretRegistryEntry[] | undefined;
    getBearer: () => Promise<string>;
  },
): (() => void) | undefined {
  const { hosted, session, secrets, getBearer, ...rest } = args;
  if (!hosted || !session || !secrets || rest.owner.executionScope)
    return undefined;
  return () => {
    void getBearer().then(
      (bearer) =>
        startSessionSnapshotSave({ ...rest, session, secrets, bearer }),
      (error: unknown) => logSaveFailure(rest.owner.harnessId, error),
    );
  };
}

function logSaveFailure(harnessId: string, error: unknown): void {
  logger.warn("[harness][snapshot] save failed", {
    harnessId,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Start a save without waiting for it; the outcome is only logged. */
export function startSessionSnapshotSave(args: SaveSessionSnapshotArgs): void {
  const startedAt = Date.now();
  void saveSessionSnapshot(args).then(
    (outcome) => {
      logger.info(
        `[harness][snapshot] save ${outcome} in ${Date.now() - startedAt}ms`,
        {
          harnessId: args.owner.harnessId,
          outcome,
        },
      );
    },
    (error: unknown) => logSaveFailure(args.owner.harnessId, error),
  );
}
