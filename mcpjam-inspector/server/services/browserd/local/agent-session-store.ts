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
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { validateLocalProjectKey } from "../../../utils/computers/local-machine.js";
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
  | { ok: false; reason: "nothing_to_attach" };

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
  const now = args.now ?? Date.now;
  const attach = args.attach ?? "prefer";
  if (attach !== "never" && args.profile === "persistent") {
    const live = await findOpenSession(args.projectId);
    if (live) {
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
  const { session, ledger, bootId } = args;
  const dir = sessionDir(session.projectId, session.sessionId);
  await ensureDir(dir);

  const continuing = session.lastBootId === bootId;
  const restarted = session.lastBootId !== undefined && !continuing;
  // The SAME boot continues from where we left off; any other boot starts from
  // its beginning. Reading from 0 on a continuing boot would duplicate every
  // row we already have, and continuing from a previous boot's cursor into a
  // fresh ring would skip the new boot's opening rows.
  const afterSeq = continuing ? (session.lastBootSeq ?? 0) : 0;
  const { entries } = ledger.read({ afterSeq, limit: 1000 });

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
    // ARTIFACTS FIRST, then serialize. Draining can mark a descriptor
    // `evicted` — a session that asked for no screenshots, or a payload that
    // could not be written — and a row stringified beforehand would claim on
    // disk that a picture is retrievable when it is not.
    if (entry.kind === "command" && entry.artifacts) {
      for (const ref of Object.values(entry.artifacts)) {
        if (!ref || ref.evicted) continue;
        if (
          args.captureScreenshots === false &&
          ref.mediaType.startsWith("image/")
        ) {
          // A session that wanted a ledger without pictures still gets the row
          // and the descriptor; the payload is dropped from the daemon rather
          // than written to disk.
          ledger.releaseArtifact(ref.id);
          ref.evicted = true;
          continue;
        }
        const saved = await drainArtifact(dir, ledger, ref.id).catch((error) => {
          logger.warn("[browser-ledger] artifact could not be saved", {
            artifactId: ref.id,
            detail: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
        // A payload we could not save is marked on the row rather than left
        // looking retrievable: "there was a screenshot and it is gone" is a
        // different and more useful statement than a dangling id.
        if (!saved) ref.evicted = true;
      }
    }
    const stored: StoredLedgerEntry = { ...entry, seq, bootSeq: entry.seq };
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
 * Move one artifact payload from the daemon's buffer onto disk.
 *
 * Released from the daemon afterwards, because its store is a hand-off buffer
 * and not a second copy: holding megabytes of pictures that already exist as
 * files is how a long session runs a laptop out of memory.
 */
async function drainArtifact(
  dir: string,
  ledger: Pick<CommandLedger, "artifact" | "releaseArtifact">,
  artifactId: string,
): Promise<boolean> {
  const payload = ledger.artifact(artifactId);
  // Already gone from the daemon's buffer — it aged out before anything
  // mirrored it. Nothing to save, and the caller marks the row accordingly.
  if (!payload) return false;
  const artifactsDir = join(dir, ARTIFACTS_DIR);
  await ensureDir(artifactsDir);
  const file = join(artifactsDir, artifactFileName(artifactId, payload.mediaType));
  await writeFile(
    file,
    payload.encoding === "base64"
      ? Buffer.from(payload.data, "base64")
      : payload.data,
    { mode: 0o600 },
  );
  ledger.releaseArtifact(artifactId);
  return true;
}

function artifactFileName(artifactId: string, mediaType: string): string {
  const extension = mediaType === "image/jpeg" ? "jpg" : "txt";
  // The id is minted by the daemon and never reaches here from a caller, but
  // this path is joined onto a directory, so the segment is still constrained.
  const safe = artifactId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) throw new Error("invalid artifact id");
  return `${safe}.${extension}`;
}

/** Read one artifact back off disk, for the trace's fetch-by-id. */
export async function readArtifact(args: {
  projectId: string;
  sessionId: string;
  artifactId: string;
  mediaType: string;
}): Promise<Buffer | undefined> {
  const file = join(
    sessionDir(args.projectId, args.sessionId),
    ARTIFACTS_DIR,
    artifactFileName(args.artifactId, args.mediaType),
  );
  return readFile(file).catch(() => undefined);
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
  const file = join(
    sessionDir(args.projectId, args.sessionId),
    LEDGER_FILE,
  );
  const raw = await readFile(file, "utf8").catch(() => "");
  const limit = Math.max(1, Math.min(args.limit ?? 100, 1000));
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
  const now = args.now ?? Date.now;
  const dir = sessionDir(args.session.projectId, args.session.sessionId);
  await ensureDir(dir);
  const seq = args.session.lastSeq + 1;
  const row: StoredLedgerEntry = {
    kind: "command",
    seq,
    bootSeq: args.session.lastBootSeq ?? 0,
    commandId: `note_${randomUUID()}`,
    sessionId: args.session.sessionId,
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
  const next = { ...args.session, lastSeq: seq };
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
