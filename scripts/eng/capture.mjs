/**
 * Session capture. Each checkpoint reads only the part of the host
 * transcript written since the last one, redacts it, and appends the events
 * to the session's log in the git common directory, so an interrupted
 * session keeps everything captured up to its last Stop. The session
 * record is rebuilt from that log and queued under one key per session,
 * so Kestral holds one document per session, updated at each checkpoint.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { enqueue } from './outbox.mjs';
import { renderSession } from './record.mjs';
import { redact } from './redact.mjs';
import { hashKey } from './state.mjs';
import { parseTranscript } from './transcripts.mjs';

const fresh = () => ({
  offset: 0,
  events: 0,
  unknown: 0,
  untimed: 0,
  note: null,
});

const logPath = (co, session) =>
  join(
    co.dir,
    'sessions',
    `${session.host}-${hashKey(session.sessionId)}.events.jsonl`
  );

/** Complete lines written since `offset`, and how many bytes they span. */
function newLines(path, offset) {
  const size = statSync(path).size;
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  const end = buffer.lastIndexOf(0x0a) + 1;
  return { text: buffer.subarray(0, end).toString('utf8'), bytes: end };
}

/** Read new transcript lines into the log. Updates and returns session.capture. */
export function checkpoint(co, session) {
  const capture = { ...fresh(), ...session.capture };
  const path = session.transcriptPath;
  const log = logPath(co, session);
  mkdirSync(dirname(log), { recursive: true });
  if (!path || !existsSync(path)) {
    capture.status = 'unavailable';
    capture.note = path
      ? `the transcript at ${path} could not be read`
      : 'the host gave no transcript path';
    session.capture = capture;
    return capture;
  }
  if (statSync(path).size < capture.offset) {
    // The host rewrote the transcript (compaction, clear): start over.
    Object.assign(capture, fresh(), {
      note: 'the host rewrote its transcript; it was read again from the start',
    });
    writeFileSync(log, '');
  }
  const { text, bytes } = newLines(path, capture.offset);
  const { events, unknown } = parseTranscript(session.host, text);
  const clean = events.map((event) => ({
    ...event,
    text: redact(event.text),
    ...(event.detail ? { detail: redact(event.detail) } : {}),
  }));
  if (clean.length) {
    appendFileSync(
      log,
      clean.map((event) => `${JSON.stringify(event)}\n`).join('')
    );
  }
  capture.offset += bytes;
  capture.events += clean.length;
  capture.unknown += unknown;
  capture.untimed += clean.filter((event) => !event.at).length;
  capture.status = capture.unknown ? 'partial' : 'complete';
  session.capture = capture;
  return capture;
}

export function readLog(co, session) {
  const log = logPath(co, session);
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Checkpoint, then queue the session record (one document per part). A
 * failure is recorded on the session, so the record and the review page
 * say the capture is incomplete instead of the hook failing quietly.
 */
export function captureSession(co, session, task, at) {
  try {
    checkpoint(co, session);
  } catch (error) {
    session.capture = {
      ...fresh(),
      ...session.capture,
      status: 'unavailable',
      note: `capture failed: ${error.message}`,
    };
  }
  const parts = renderSession({
    session,
    events: readLog(co, session),
    task,
    at,
  });
  parts.forEach((body, index) => {
    const part =
      parts.length > 1 ? ` (part ${index + 1} of ${parts.length})` : '';
    enqueue(co, {
      key: `session:${session.host}:${session.sessionId}:${index + 1}`,
      kind: 'session',
      task: task.key,
      title: `Session record: ${session.host} ${session.sessionId.slice(0, 8)}${part}`,
      body,
    });
  });
  return session.capture;
}
