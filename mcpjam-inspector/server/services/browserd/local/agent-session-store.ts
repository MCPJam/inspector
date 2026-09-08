/**
 * The LOGICAL browser session, and its durable ledger — on this machine.
 *
 * WHY A NEW ENTITY. The hosted `browserSessions` row is a BOOT record, not a
 * session: `internalRecordSession` deletes the observed row and inserts a new
 * one on every relaunch, so its id changes whenever the bundle, the protocol or
 * the box changes. Locally there is no row at all — just one Chromium per
 * (project, context mode). Neither can carry an agent's history, a participant
 * list, or a permalink, because both are replaced by a deploy. The logical
 * session is the thing that survives that, and the boots it has spanned are
 * recorded ON it rather than being it.
 *
 * SINGLE WRITER, deliberately. This file is the only thing that writes these
 * files, and the CLI reaches them exclusively through `POST /local-browser/*`.
 * A CLI that wrote the session file directly would need a locking protocol
 * between two processes that have no other reason to coordinate — invented to
 * solve a problem we can simply not have.
 *
 * THE LEDGER SINK. The daemon's ring is bounded and per-boot; this mirrors it
 * into JSONL and drains the artifact payloads to files beside it. Two
 * consequences the design leans on:
 *   - the durable `seq` is minted HERE and is monotonic across boots, while the
 *     daemon's `seq` restarts at 1 each time. The daemon's is kept as `bootSeq`,
 *     so a row can still be found in the ring it came from.
 *   - a bootId change between mirrors is a `daemon_restart` gap. A relaunch is
 *     then visible in the trace instead of reading as a quiet stretch.
 */
import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { validateLocalProjectKey } from "../../../utils/computers/local-machine.js";
import { withKeyedLock } from "../probe-lock.js";
import { logger } from "../../../utils/logger.js";
import { getLocalBrowserRoot } from "./local-browser-session.js";
import type {
  BrowserLedgerEntry,
  BrowserLedgerGap,
  BrowserLedgerRow,
  CommandLedger,
} from "../daemon/command-ledger.js";
import type {
  BrowserAgentSession,
  BrowserAgentSessionPolicy,
} from "../../../../shared/browser-agent-contract.js";

/** A durable row: the daemon's, re-keyed onto a seq that survives a relaunch. */
export type StoredLedgerEntry = (
  | (Omit<BrowserLedgerRow, "seq"> & { bootSeq: number })
  | (Omit<BrowserLedgerGap, "seq"> & { bootSeq?: number })
) & {
  /** Monotonic for the life of the SESSION, across every boot it spanned. */
  seq: number;
};

export interface AgentSessionRecord extends BrowserAgentSession {
  /**
   * WHICH live browser this session drives.
   *
   * A project does not name one. An ephemeral context is keyed by the run that
   * owns it, so resolving a session's commands by project alone reached the
   * project's persistent browser — a person's real logged-in Chromium, driven
   * under a policy they never agreed to. The key survives a relaunch, which a
   * boot id does not, so it is what a session stores to find its way back.
   *
   * Optional because sessions written before this field exist on disk; a
   * persistent one falls back to the project's browser, and an ephemeral one
   * without it refuses rather than guessing.
   */
  browserKey?: string;
  /** The durable seq the last mirror wrote. The next one continues from here. */
  lastSeq: number;
  /** The daemon boot the last mirror read, and how far into its ring it got. */
  lastBootId?: string;
  lastBootSeq?: number;
}

const SESSIONS_DIR = "sessions";
const LEDGER_FILE = "ledger.jsonl";
const SESSION_FILE = "session.json";
const ARTIFACTS_DIR = "artifacts";

/**
 * A session id shaped so it can be a path segment without further validation.
 *
 * `bs_` plus a uuid with the dashes kept: readable in a CLI argument, unique
 * without coordination, and containing nothing a filesystem or a URL cares
 * about.
 */
function mintSessionId(): string {
  return `bs_${randomUUID()}`;
}

/** Reject anything that is not a session id we minted. */
export function validateSessionId(sessionId: string): string {
  if (!/^bs_[0-9a-f-]{36}$/.test(sessionId)) {
    throw new Error("Invalid browser session id.");
  }
  return sessionId;
}

function sessionsRoot(projectId: string): string {
  const key = validateLocalProjectKey(projectId);
  const root = getLocalBrowserRoot();
  const dir = resolve(root, key, SESSIONS_DIR);
  // Belt and braces over the key validation, matching the profile path's own
  // check: a key that ever slipped through the pattern would otherwise write a
  // session tree wherever it pointed.
  if (!dir.startsWith(root + sep)) {
    throw new Error(`invalid local browser session path for project ${key}`);
  }
  return dir;
}

function sessionDir(projectId: string, sessionId: string): string {
  return join(sessionsRoot(projectId), validateSessionId(sessionId));
}

/**
 * Where a project's artifact payloads live — ONE store, not one per session.
 *
 * Two logical sessions can share a browser, and a command nobody claimed is
 * mirrored into both of their histories. With a store per session the first
 * mirror wrote the bytes into its own directory and released the daemon's only
 * copy, so the second session recorded the very same screenshot as `evicted`
 * and could never fetch it. The payload is the browser's, not a session's.
 *
 * SO THE PATH NO LONGER SCOPES A READ. When every session had its own
 * directory, `readArtifact` was authorized by where it looked; sharing the
 * store took that away, and the route must now REFUSE an id that `artifactMediaType`
 * does not find in this session's ledger. It did not at first — it read the
 * descriptor and then read the bytes anyway — which made a guessed id enough to
 * pull another session's screenshot out of the shared store. This function is
 * not the place that check lives, but it is the reason it has to exist.
 */
function artifactsRoot(projectId: string): string {
  return join(dirname(sessionsRoot(projectId)), ARTIFACTS_DIR);
}

async function ensureDir(dir: string): Promise<void> {
  // 0700 throughout: these files hold a browsing history and the screenshots
  // that go with it, on a machine whose browser is signed into things.
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** A write that failed is REPORTED, never swallowed. @see historyWarning */
export class LedgerSinkError extends Error {
  constructor(readonly detail: string) {
    super(`the browser session's history could not be recorded: ${detail}`);
    this.name = "LedgerSinkError";
  }
}

export interface OpenSessionArgs {
  projectId: string;
  engine: string;
  profile: "persistent" | "ephemeral";
  policy: BrowserAgentSessionPolicy;
  createdBy: string;
  actor: { actorId: string; kind: string };
  bootId: string;
  /** The live browser this session drives; see `AgentSessionRecord`. */
  browserKey?: string;
  /**
   * `prefer` (default) joins a live session for this project, else creates one.
   * `never` always creates. `require` refuses when there is nothing to join.
   */
  attach?: "prefer" | "never" | "require";
  captureTypedText?: boolean;
  captureScreenshots?: boolean;
  now?: () => number;
}

export type OpenSessionResult =
  | { ok: true; session: AgentSessionRecord; attached: boolean }
  | { ok: false; reason: "nothing_to_attach" }
  /** The live session's policy differs; `session` is the one that is running. */
  | {
      ok: false;
      reason: "policy_mismatch";
      session: AgentSessionRecord;
    };

/** Two policies are the same session's policy only if they say the same thing. */
function policiesMatch(
  a: BrowserAgentSessionPolicy,
  b: BrowserAgentSessionPolicy,
): boolean {
  const list = (values: readonly string[] | undefined) =>
    [...(values ?? [])].sort().join("\u0000");
  return (
    a.mode === b.mode &&
    list(a.originAllowlist) === list(b.originAllowlist) &&
    list(a.toolAllowlist) === list(b.toolAllowlist)
  );
}

/**
 * Attach to this project's live session, or create one.
 *
 * ATTACHING IS THE DEFAULT because the ask is a browser an agent and a person
 * share: an agent that always created its own session would give the user a
 * second browser to watch and a second history to read, which is the opposite
 * of "the same session, either can take over".
 *
 * An EPHEMERAL session is never attachable. It belongs to one unattended run,
 * and the whole point of having no profile is that one run cannot inherit
 * another's cookies — joining one would hand that back.
 */
export async function openAgentSession(
  args: OpenSessionArgs,
): Promise<OpenSessionResult> {
  // SERIALIZED PER PROJECT. Discovery and creation are separate awaits over the
  // filesystem, so two callers opening the same project together can both find
  // nothing and both create — leaving two attachable persistent sessions where
  // the whole point is that there is one to share.
  return withKeyedLock(`browser-session-open:${args.projectId}`, () =>
    openAgentSessionLocked(args),
  );
}

async function openAgentSessionLocked(
  args: OpenSessionArgs,
): Promise<OpenSessionResult> {
  const now = args.now ?? Date.now;
  const attach = args.attach ?? "prefer";
  if (attach !== "never" && args.profile === "persistent") {
    const live = await findOpenSession(args.projectId);
    if (live) {
      // A POLICY MISMATCH IS REFUSED, not silently resolved. Attaching means
      // sharing one browser under one policy: taking the caller's would widen
      // what the existing participants agreed to, and ignoring it would tell a
      // caller its `read_only` was accepted while it drives a session that can
      // click anything. Neither is something to decide on a caller's behalf.
      if (!policiesMatch(live.policy, args.policy)) {
        return { ok: false, reason: "policy_mismatch", session: live };
      }
      const joined = await joinSession(live, args.actor, args.bootId, now());
      return { ok: true, session: joined, attached: true };
    }
    if (attach === "require") return { ok: false, reason: "nothing_to_attach" };
  } else if (attach === "require") {
    // `require` on an ephemeral profile can never be satisfiable, and saying so
    // is better than creating a session the caller explicitly did not ask for.
    return { ok: false, reason: "nothing_to_attach" };
  }
  const session: AgentSessionRecord = {
    sessionId: mintSessionId(),
    projectId: validateLocalProjectKey(args.projectId),
    engine: args.engine,
    profile: args.profile,
    policy: args.policy,
    ...(args.browserKey ? { browserKey: args.browserKey } : {}),
    createdBy: args.createdBy,
    createdAt: now(),
    participants: [{ ...args.actor, joinedAt: now() }],
    boots: [{ bootId: args.bootId, startedAt: now() }],
    // Refused for a persistent profile by the door; defaulted off here so a
    // caller that never mentions it cannot end up with it on.
    ...(args.captureTypedText ? { captureTypedText: true } : {}),
    ...(args.captureScreenshots === false ? { captureScreenshots: false } : {}),
    lastSeq: 0,
  };
  await writeSession(session);
  return { ok: true, session, attached: false };
}

async function joinSession(
  session: AgentSessionRecord,
  actor: { actorId: string; kind: string },
  bootId: string,
  at: number,
): Promise<AgentSessionRecord> {
  const already = session.participants.some((p) => p.actorId === actor.actorId);
  const next: AgentSessionRecord = {
    ...session,
    participants: already
      ? session.participants
      : [...session.participants, { ...actor, joinedAt: at }],
    boots: session.boots.some((b) => b.bootId === bootId)
      ? session.boots
      : [...session.boots, { bootId, startedAt: at }],
  };
  await writeSession(next);
  return next;
}

/** The live (unclosed) persistent session for a project, if any. */
export async function findOpenSession(
  projectId: string,
): Promise<AgentSessionRecord | undefined> {
  const sessions = await listAgentSessions(projectId);
  // Newest first: a project should only ever have one open persistent session,
  // but if a crash ever left two, joining the most recent is the answer that
  // matches what the person is looking at.
  return sessions
    .filter((s) => !s.closedAt && s.profile === "persistent")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

export async function listAgentSessions(
  projectId: string,
): Promise<AgentSessionRecord[]> {
  const root = sessionsRoot(projectId);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    // No sessions directory yet is the ordinary first-run state, not a failure.
    return [];
  }
  const sessions: AgentSessionRecord[] = [];
  for (const name of names) {
    const session = await readSession(projectId, name).catch(() => undefined);
    if (session) sessions.push(session);
  }
  return sessions;
}

export async function readSession(
  projectId: string,
  sessionId: string,
): Promise<AgentSessionRecord | undefined> {
  try {
    const raw = await readFile(
      join(sessionDir(projectId, sessionId), SESSION_FILE),
      "utf8",
    );
    return JSON.parse(raw) as AgentSessionRecord;
  } catch {
    return undefined;
  }
}

async function writeSession(session: AgentSessionRecord): Promise<void> {
  const dir = sessionDir(session.projectId, session.sessionId);
  await ensureDir(dir);
  await writeFile(
    join(dir, SESSION_FILE),
    JSON.stringify(session, null, 2),
    { mode: 0o600 },
  );
}

/**
 * Remove a participant. The browser lives on for the others.
 *
 * `close` DETACHES by default because a session is shared: an agent finishing
 * its work must not close the window the person is still watching. Terminating
 * is a separate, explicit act — and it is the caller's job to check the lease
 * first, because "close the browser somebody else is holding" is the one thing
 * this function must not do silently.
 */
export async function leaveAgentSession(args: {
  projectId: string;
  sessionId: string;
  actorId: string;
  terminate?: boolean;
  now?: () => number;
}): Promise<AgentSessionRecord | undefined> {
  // THE SAME LOCK THE MIRROR TAKES. Both are read-modify-writes over one
  // session file, and without a shared lock they interleave: the mirror reads
  // an open record, this writes `closedAt`, and the mirror then writes its own
  // copy back — un-closing a session somebody had just ended.
  return withKeyedLock(`browser-ledger:${args.sessionId}`, () =>
    leaveAgentSessionLocked(args),
  );
}

async function leaveAgentSessionLocked(args: {
  projectId: string;
  sessionId: string;
  actorId: string;
  terminate?: boolean;
  now?: () => number;
}): Promise<AgentSessionRecord | undefined> {
  const now = args.now ?? Date.now;
  const session = await readSession(args.projectId, args.sessionId);
  if (!session) return undefined;
  const next: AgentSessionRecord = {
    ...session,
    participants: session.participants.filter(
      (p) => p.actorId !== args.actorId,
    ),
    ...(args.terminate ? { closedAt: now() } : {}),
  };
  await writeSession(next);
  return next;
}

/**
 * Copy everything new out of the daemon's ring into this session's JSONL.
 *
 * Called on every command the door proxies and on every trace read, which is
 * what keeps the bounded ring from ever being the thing that loses history: the
 * ring only has to survive between two mirrors, not for the life of a session.
 *
 * Model-sourced commands are picked up here too, for free — they went through
 * the same daemon handler and are sitting in the same ring — which is the first
 * time the rail can show what the Playground's model did.
 */
export async function mirrorLedger(args: {
  session: AgentSessionRecord;
  ledger: Pick<CommandLedger, "read" | "artifact" | "releaseArtifact">;
  bootId: string;
  /** Persist screenshot/tree payloads beside the rows. Off honours the session. */
  captureScreenshots?: boolean;
}): Promise<{ session: AgentSessionRecord; written: number }> {
  // SERIALIZED PER SESSION. This is a read-modify-write over one file: it reads
  // `lastBootSeq`, appends the ring slice past it, and writes the cursor back.
  // Two commands on different tabs — or one command racing the rail's trace
  // poll — would otherwise both read the same cursor, both append the same
  // slice, and advance it once, so the durable trace would show a click twice.
  // Duplicated history is worse than missing history: a gap says so and a
  // duplicate does not.
  //
  // Keyed by session, so two projects still mirror concurrently.
  return withKeyedLock(`browser-ledger:${args.session.sessionId}`, () =>
    mirrorLedgerLocked(args),
  );
}

async function mirrorLedgerLocked(args: {
  session: AgentSessionRecord;
  ledger: Pick<CommandLedger, "read" | "artifact" | "releaseArtifact">;
  bootId: string;
  captureScreenshots?: boolean;
}): Promise<{ session: AgentSessionRecord; written: number }> {
  const { ledger, bootId } = args;
  // RE-READ under the lock. The caller's copy was taken before it queued, so a
  // mirror that ran while it waited has already advanced the cursor — using the
  // stale copy would re-append everything that one just wrote.
  const session = (await readSession(
    args.session.projectId,
    args.session.sessionId,
  )) ?? args.session;
  if (session.closedAt) return { session, written: 0 };
  // A FINISHED session stops growing, decided HERE rather than on the caller's
  // snapshot. The caller read the record before it queued for this lock, so a
  // `terminate` landing in between would otherwise still copy the live ring
  // into a history that had ended — and then write this function's `next`,
  // built from the pre-close read, back over the record and clear `closedAt`.
  const dir = sessionDir(session.projectId, session.sessionId);
  await ensureDir(dir);
  const artifactsDir = artifactsRoot(session.projectId);

  const continuing = session.lastBootId === bootId;
  const restarted = session.lastBootId !== undefined && !continuing;
  // The SAME boot continues from where we left off; any other boot starts from
  // its beginning. Reading from 0 on a continuing boot would duplicate every
  // row we already have, and continuing from a previous boot's cursor into a
  // fresh ring would skip the new boot's opening rows.
  const afterSeq = continuing ? (session.lastBootSeq ?? 0) : 0;
  // ROWS FOR THIS SESSION, plus rows nobody claimed. Two logical sessions can
  // share one project browser, and copying the whole ring into whichever one is
  // being read would put each session's commands in the other's history. A row
  // with no `sessionId` is a model- or pane-driven command on the shared
  // browser, which genuinely belongs in every session's view of it.
  const { entries } = ledger
    .read({ afterSeq, limit: 1000 })
    .entries.reduce<{ entries: BrowserLedgerEntry[] }>(
      (acc, entry) => {
        if (
          entry.kind !== "command" ||
          entry.sessionId === undefined ||
          entry.sessionId === session.sessionId
        ) {
          acc.entries.push(entry);
        }
        return acc;
      },
      { entries: [] },
    );

  const lines: string[] = [];
  let seq = session.lastSeq;
  let bootSeq = session.lastBootSeq ?? 0;

  if (restarted) {
    // The ring is new and cannot know it replaced another. Whoever notices the
    // bootId change writes the gap, or a relaunch mid-session reads as a quiet
    // stretch rather than as a browser that went away and came back.
    seq += 1;
    const gap: StoredLedgerEntry = {
      kind: "gap",
      seq,
      bootId,
      ts: Date.now(),
      // In the DURABLE sequence's own coordinates, not the old boot's: a
      // restart marks a point rather than spanning a range, and quoting a
      // previous ring's numbering here would put two unrelated sequences in one
      // file with nothing to say which was which.
      fromSeq: session.lastSeq,
      toSeq: session.lastSeq,
      reason: "daemon_restart",
    };
    lines.push(JSON.stringify(gap));
  }

  for (const entry of entries) {
    seq += 1;
    bootSeq = Math.max(bootSeq, entry.seq);
    // ARTIFACTS FIRST, then serialize. Draining decides whether a descriptor is
    // `evicted` — a session that asked for no screenshots, or a payload that
    // could not be written — and a row stringified beforehand would claim on
    // disk that a picture is retrievable when it is not.
    //
    // COPIED, NEVER MUTATED IN PLACE. These descriptors belong to the daemon's
    // ring, which two logical sessions mirror from. Writing `evicted` onto them
    // made one session's answer the other's premise: the session that wanted no
    // screenshots marked the shared row, and the next session skipped a payload
    // that was sitting right there — recording somebody else's preference as
    // its own missing picture.
    const artifacts =
      entry.kind === "command" && entry.artifacts
        ? await drainArtifacts(entry.artifacts, {
            artifactsDir,
            ledger,
            ...(args.captureScreenshots === false
              ? { captureScreenshots: false }
              : {}),
          })
        : undefined;
    const stored: StoredLedgerEntry = {
      ...entry,
      ...(artifacts ? { artifacts } : {}),
      seq,
      bootSeq: entry.seq,
    };
    lines.push(JSON.stringify(stored));
  }

  if (lines.length > 0) {
    try {
      await appendFile(join(dir, LEDGER_FILE), lines.join("\n") + "\n", {
        mode: 0o600,
      });
    } catch (error) {
      // NOT best-effort. The caller turns this into a `historyWarning` on the
      // command that could not be recorded, so a caller is never quietly left
      // with a trace that is missing the very command it just ran.
      throw new LedgerSinkError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const next: AgentSessionRecord = {
    ...session,
    lastSeq: seq,
    lastBootId: bootId,
    lastBootSeq: bootSeq,
  };
  if (lines.length > 0 || restarted || session.lastBootId !== bootId) {
    await writeSession(next);
  }
  return { session: next, written: lines.length };
}

/**
 * This session's copy of one row's artifact descriptors, payloads saved.
 *
 * @see the call site for why a copy rather than the ring's own objects.
 */
async function drainArtifacts(
  refs: NonNullable<BrowserLedgerRow["artifacts"]>,
  args: {
    artifactsDir: string;
    ledger: Pick<CommandLedger, "artifact" | "releaseArtifact">;
    captureScreenshots?: boolean;
  },
): Promise<NonNullable<BrowserLedgerRow["artifacts"]>> {
  const copy: NonNullable<BrowserLedgerRow["artifacts"]> = {};
  for (const slot of ARTIFACT_SLOTS) {
    const ref = refs[slot];
    if (!ref) continue;
    if (ref.evicted) {
      copy[slot] = { ...ref };
      continue;
    }
    if (
      args.captureScreenshots === false &&
      ref.mediaType.startsWith("image/")
    ) {
      // A session that wanted a ledger without pictures still gets the row and
      // the descriptor; the payload is simply not written to disk.
      //
      // NOT released from the daemon, either. This session's preference is
      // about its own history, and another session sharing this browser may
      // still be about to mirror the same command. The ring's own cap frees it.
      copy[slot] = { ...ref, evicted: true };
      continue;
    }
    const saved = await drainArtifact(args.artifactsDir, args.ledger, ref.id)
      .catch((error) => {
        logger.warn("[browser-ledger] artifact could not be saved", {
          artifactId: ref.id,
          detail: error instanceof Error ? error.message : String(error),
        });
        return false;
      });
    // A payload we could not save is marked on the row rather than left looking
    // retrievable: "there was a screenshot and it is gone" is a different and
    // more useful statement than a dangling id.
    copy[slot] = saved ? { ...ref } : { ...ref, evicted: true };
  }
  return copy;
}

/** The row's artifact slots, so a copy cannot silently miss one. */
const ARTIFACT_SLOTS = ["screenshot", "a11y", "text"] as const satisfies ReadonlyArray<
  keyof NonNullable<BrowserLedgerRow["artifacts"]>
>;

/**
 * Move one artifact payload from the daemon's buffer into the project's store.
 *
 * Released from the daemon afterwards, because its store is a hand-off buffer
 * and not a second copy: holding megabytes of pictures that already exist as
 * files is how a long session runs a laptop out of memory.
 */
async function drainArtifact(
  artifactsDir: string,
  ledger: Pick<CommandLedger, "artifact" | "releaseArtifact">,
  artifactId: string,
): Promise<boolean> {
  const file = join(artifactsDir, artifactFileName(artifactId));
  const payload = ledger.artifact(artifactId);
  if (!payload) {
    // Gone from the daemon's buffer. Either a peer session already drained it
    // into the shared store — in which case this row's descriptor is perfectly
    // good and marking it `evicted` would be a lie — or it aged out before
    // anything mirrored it, which is the genuine loss.
    return await access(file)
      .then(() => true)
      .catch(() => false);
  }
  await ensureDir(artifactsDir);
  // WRITTEN ASIDE, THEN RENAMED. The store is the PROJECT's, but the mirror
  // serializes per SESSION — so two sessions copying the same unclaimed row
  // hold different locks and can both reach this line for the same id, each
  // having read the payload before either released it. `writeFile` truncates
  // first, so a reader landing in that window gets a short buffer for a
  // screenshot that is perfectly intact. A rename within one directory is
  // atomic: a reader sees the old file or the whole new one, never a half.
  const staging = `${file}.${randomUUID()}.part`;
  try {
    await writeFile(
      staging,
      payload.encoding === "base64"
        ? Buffer.from(payload.data, "base64")
        : payload.data,
      { mode: 0o600 },
    );
    await rename(staging, file);
  } catch (error) {
    // A staging file left behind would be a permanent 0600 orphan nothing ever
    // reads; the write's own failure is what the caller needs to hear.
    await rm(staging, { force: true }).catch(() => {});
    throw error;
  }
  ledger.releaseArtifact(artifactId);
  return true;
}

/**
 * The file one artifact is stored as.
 *
 * NAMED BY ID ALONE, with no extension derived from the media type. Coupling
 * them meant a reader had to already know an artifact's type in order to find
 * it: a caller fetching a text artifact without saying so looked for `<id>.jpg`
 * and got a 410 for a file sitting right there under `<id>.txt`. The row
 * carries the media type; the filename only has to be unique and safe.
 */
function artifactFileName(artifactId: string): string {
  // The id is minted by the daemon and never reaches here from a caller, but
  // this path is joined onto a directory, so the segment is still constrained.
  const safe = artifactId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) throw new Error("invalid artifact id");
  return safe;
}

/** Read one artifact back off disk, for the trace's fetch-by-id. */
export async function readArtifact(args: {
  projectId: string;
  sessionId: string;
  artifactId: string;
}): Promise<Buffer | undefined> {
  const name = artifactFileName(args.artifactId);
  const shared = await readFile(
    join(artifactsRoot(args.projectId), name),
  ).catch(() => undefined);
  if (shared) return shared;
  // Payloads written before the store moved up to the project still sit under
  // the session that mirrored them, and a trace a person is reading today is
  // not worth breaking to tidy a path.
  return readFile(
    join(sessionDir(args.projectId, args.sessionId), ARTIFACTS_DIR, name),
  ).catch(() => undefined);
}

/**
 * What kind of thing an artifact is, according to the row that named it.
 *
 * The DESCRIPTOR is the authority, not the caller: a request that names its own
 * media type is naming what it hopes to get, and echoing that back into a
 * `content-type` is how page-derived text ends up served as HTML.
 */
export async function artifactMediaType(args: {
  projectId: string;
  sessionId: string;
  artifactId: string;
}): Promise<string | undefined> {
  // THE WHOLE LEDGER, not a page of it. `readLedger` is the paged reader a
  // cursor walks; asking it for the first thousand rows answered "no such
  // artifact" for every artifact after the thousandth, and the route served a
  // perfectly good screenshot as an octet-stream. This is a lookup by id, not a
  // page, so it has no business having a page size.
  //
  // NEWEST FIRST: a caller fetching an artifact has almost always just been
  // handed it, and a long session should not be scanned from the beginning to
  // find the row it made a moment ago.
  const entries = await readLedgerFile(args.projectId, args.sessionId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== "command" || !entry.artifacts) continue;
    for (const ref of Object.values(entry.artifacts)) {
      if (ref?.id === args.artifactId) return ref.mediaType;
    }
  }
  return undefined;
}

/** Every row in a session's ledger file, in order. One unreadable line is skipped. */
async function readLedgerFile(
  projectId: string,
  sessionId: string,
): Promise<StoredLedgerEntry[]> {
  const raw = await readFile(
    join(sessionDir(projectId, sessionId), LEDGER_FILE),
    "utf8",
  ).catch(() => "");
  const all: StoredLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line) as StoredLedgerEntry);
    } catch {
      // One unreadable line does not make the rest of the history unreadable.
      // It is skipped rather than fatal, and the seq gap it leaves is visible.
    }
  }
  return all;
}

/**
 * Read the session's durable trace forward from a cursor.
 *
 * Incremental by default: both the CLI's `trace` and the rail's Activity list
 * tail with the last `seq` they saw. Reading the whole file and filtering is
 * honest at this size — a session's ledger is thousands of rows, not millions —
 * and the alternative (an index) would be a second thing to keep correct.
 */
export async function readLedger(args: {
  projectId: string;
  sessionId: string;
  afterSeq?: number;
  commandId?: string;
  limit?: number;
}): Promise<{ entries: StoredLedgerEntry[]; headSeq: number }> {
  const limit = Math.max(1, Math.min(args.limit ?? 100, 1000));
  const all = await readLedgerFile(args.projectId, args.sessionId);
  const headSeq = all.length ? all[all.length - 1].seq : 0;
  let matched: StoredLedgerEntry[] = all;
  if (args.commandId !== undefined) {
    matched = matched.filter(
      (e) => e.kind === "command" && e.commandId === args.commandId,
    );
  }
  if (args.afterSeq !== undefined) {
    matched = matched.filter((e) => e.seq > args.afterSeq!);
  }
  return { entries: matched.slice(0, limit), headSeq };
}

/** A marker row: `note_browser_session`, and nothing else. */
export async function appendNote(args: {
  session: AgentSessionRecord;
  text: string;
  actor: BrowserLedgerRow["actor"];
  bootId: string;
  now?: () => number;
}): Promise<AgentSessionRecord> {
  // The same read-modify-write over the same file as `mirrorLedger`, so it
  // takes the same lock: a note racing a mirror would otherwise mint a seq the
  // mirror is about to mint too, and two rows would claim one position.
  return withKeyedLock(`browser-ledger:${args.session.sessionId}`, () =>
    appendNoteLocked(args),
  );
}

async function appendNoteLocked(args: {
  session: AgentSessionRecord;
  text: string;
  actor: BrowserLedgerRow["actor"];
  bootId: string;
  now?: () => number;
}): Promise<AgentSessionRecord> {
  const now = args.now ?? Date.now;
  const dir = sessionDir(args.session.projectId, args.session.sessionId);
  await ensureDir(dir);
  const session =
    (await readSession(args.session.projectId, args.session.sessionId)) ??
    args.session;
  const seq = session.lastSeq + 1;
  const row: StoredLedgerEntry = {
    kind: "command",
    seq,
    bootSeq: session.lastBootSeq ?? 0,
    commandId: `note_${randomUUID()}`,
    sessionId: session.sessionId,
    bootId: args.bootId,
    source: "agent",
    actor: args.actor,
    ts: now(),
    durationMs: 0,
    // A note is not a browser command and does not pretend to be one: its
    // record carries the marker text and no target, no verb, no page.
    command: { kind: "note", value: args.text },
    outcome: "executed",
    ok: true,
  };
  try {
    await appendFile(join(dir, LEDGER_FILE), JSON.stringify(row) + "\n", {
      mode: 0o600,
    });
  } catch (error) {
    throw new LedgerSinkError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const next = { ...session, lastSeq: seq };
  await writeSession(next);
  return next;
}

/** For tests: where this project's sessions live. */
export function agentSessionsRootForTests(projectId: string): string {
  return sessionsRoot(projectId);
}

/** Aggregate a mirror + read, the pair every reader wants. @see mirrorLedger */
export type MirrorAndRead = Awaited<ReturnType<typeof readLedger>> & {
  session: AgentSessionRecord;
  historyWarning?: string;
};

export type { BrowserLedgerEntry };
