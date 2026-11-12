/**
 * Save a harness CLI's session files off the box after a turn, so a later turn
 * on a REPLACED box can put them back and resume natively.
 *
 * Runs after the turn's transcript and resume state are saved, and nothing
 * waits for it: the user's turn is already over. Every failure ends the save
 * and is logged; a missing snapshot only means the next replaced box starts
 * blank, as it did before.
 *
 * The backend decides whether snapshots are on: `snapshot/begin` answers
 * before anything is read off the box, and reserves the key the bytes are then
 * posted under (`snapshot/save`).
 */
import { logger } from "../../logger.js";
import {
  createSecretScrubber,
  type SecretRegistryEntry,
} from "../../secrets/secret-scrubber.js";
import {
  getConvexHttpUrl,
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
/**
 * Saves one server runs at once: each holds a session's text in memory and
 * compresses it. Past this a save waits its turn. A waiting save is replaced
 * by a newer one for the same chat, since only the latest turn's copy can
 * ever be restored, and the oldest waiting save is dropped past the cap.
 */
const MAX_CONCURRENT_SAVES = 2;
const MAX_WAITING_SAVES = 50;
let runningSaves = 0;
const waitingSaves = new Map<string, SaveSessionSnapshotArgs>();

export type SnapshotSaveOutcome =
  | "saved"
  | "unsupported"
  | "refused"
  | "empty"
  | "has-secret"
  | "too-large"
  | "busy"
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

function reservation(
  payload: unknown,
): { key: string; maxBytes: number } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const key: unknown = Reflect.get(payload, "key");
  const maxBytes: unknown = Reflect.get(payload, "maxBytes");
  return Reflect.get(payload, "enabled") === true &&
    typeof key === "string" &&
    typeof maxBytes === "number"
    ? { key, maxBytes }
    : undefined;
}

export async function saveSessionSnapshot(
  args: SaveSessionSnapshotArgs,
): Promise<SnapshotSaveOutcome> {
  const signal = AbortSignal.timeout(SAVE_TIMEOUT_MS);
  const begun = await postSessionState(
    "snapshot/begin",
    args.bearer,
    {
      ...args.owner,
      harnessSessionId: args.harnessSessionId,
      stateVersion: args.stateVersion,
    },
    signal,
  );
  const reserved = begun.ok ? reservation(begun.payload) : undefined;
  if (!reserved) return "refused";

  const home = await boxHome(args.session, signal);
  const spec = sessionFileSpec({
    harnessId: args.owner.harnessId,
    harnessSessionId: args.harnessSessionId,
    resumeState: args.resumeState,
    home,
  });
  if (!spec) return "unsupported";
  let collected;
  try {
    collected = await collectSessionFiles({
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
  // A delivered secret reached the session. Its scrubbed copy would not be
  // the history the CLI signed (a thinking block's signature covers its
  // text), so no copy is kept at all rather than one that cannot resume.
  if (collected.scrubbed) return "has-secret";
  if (collected.files.length === 0) return "empty";
  let bytes;
  try {
    bytes = await encodeSnapshot({
      version: 1,
      harnessId: spec.harnessId,
      harnessSessionId: args.harnessSessionId,
      ...(args.workDir ? { workDir: args.workDir } : {}),
      files: collected.files,
    });
  } catch (error) {
    if (error instanceof SnapshotTooLargeError) return "too-large";
    throw error;
  }
  if (bytes.byteLength > reserved.maxBytes) return "too-large";

  const authorization = args.bearer.startsWith("Bearer ")
    ? args.bearer
    : `Bearer ${args.bearer}`;
  const res = await fetch(
    new URL("/web/harness/session-state/snapshot/save", getConvexHttpUrl()),
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/gzip",
        "x-mcpjam-snapshot": JSON.stringify({
          ...args.owner,
          key: reserved.key,
        }),
      },
      body: bytes,
      signal,
    },
  );
  const saved: unknown = res.ok ? await res.json() : undefined;
  return saved &&
    typeof saved === "object" &&
    Reflect.get(saved, "saved") === true
    ? "saved"
    : "failed";
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

function logOutcome(
  harnessId: string,
  outcome: SnapshotSaveOutcome,
  ms: number,
): void {
  logger.info(`[harness][snapshot] save ${outcome} in ${ms}ms`, {
    harnessId,
    outcome,
  });
}

/** Start a save without waiting for it; the outcome is only logged. */
export function startSessionSnapshotSave(args: SaveSessionSnapshotArgs): void {
  if (runningSaves >= MAX_CONCURRENT_SAVES) {
    const lane = laneKey(args.owner);
    waitingSaves.delete(lane);
    waitingSaves.set(lane, args);
    if (waitingSaves.size > MAX_WAITING_SAVES) {
      const [oldest] = waitingSaves;
      if (oldest) {
        waitingSaves.delete(oldest[0]);
        logOutcome(oldest[1].owner.harnessId, "busy", 0);
      }
    }
    return;
  }
  runningSaves += 1;
  const startedAt = Date.now();
  void saveSessionSnapshot(args)
    .then(
      (outcome) =>
        logOutcome(args.owner.harnessId, outcome, Date.now() - startedAt),
      (error: unknown) => logSaveFailure(args.owner.harnessId, error),
    )
    .finally(() => {
      runningSaves -= 1;
      const [next] = waitingSaves;
      if (next) {
        waitingSaves.delete(next[0]);
        startSessionSnapshotSave(next[1]);
      }
    });
}

function laneKey(owner: HarnessOwnerRef): string {
  return [
    owner.projectId,
    owner.harnessId,
    owner.ownerType,
    owner.scenarioId ?? "",
    owner.chatSessionId ?? "",
  ].join("\u0000");
}
