/**
 * An in-memory stand-in for the backend's revoked-session store and the
 * service-token feed that lists it (`GET /internal/v1/auth-sessions/revoked`).
 *
 * It follows the feed contract the inspector consumes:
 *   - pages are in INSERTION order, `pageSize` rows at a time;
 *   - a scan's first request (no cursor) fixes `scanStartedAt`; the cursor
 *     carries that and the scan position, and `since` is ignored once a
 *     cursor is supplied;
 *   - only the final page (`isDone: true`) carries a `watermark`,
 *     `scanStartedAt - overlapMs`;
 *   - only rows whose `expiresAt` is still ahead are returned.
 *
 * `record` is the durable write: an acknowledged sign-out, or a revocation the
 * identity provider reported. `failNext` makes the next requests throw.
 */
import type {
  RevokedSessionFeedFetcher,
  RevokedSessionFeedPage,
} from "../../services/revoked-session-cache.js";

export interface FakeRevokedSessionRow {
  sid: string;
  revokedAt: number;
  expiresAt: number;
  recordedAt: number;
  seq: number;
}

interface FeedCursor {
  scanStartedAt: number;
  since: number;
  afterSeq: number;
}

export function createRevokedSessionFeed(
  options: { pageSize?: number; overlapMs?: number; now?: () => number } = {},
) {
  const pageSize = options.pageSize ?? 500;
  const overlapMs = options.overlapMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const rows: FakeRevokedSessionRow[] = [];
  const requests: Array<{ since: number; cursor?: string }> = [];
  let seq = 0;
  let failures: Error[] = [];

  function record(
    sid: string,
    fields: { revokedAt?: number; expiresAt?: number } = {},
  ): FakeRevokedSessionRow {
    const at = now();
    const row: FakeRevokedSessionRow = {
      sid,
      revokedAt: fields.revokedAt ?? at,
      expiresAt: fields.expiresAt ?? at + 30 * 24 * 60 * 60 * 1000,
      recordedAt: at,
      seq: ++seq,
    };
    rows.push(row);
    return row;
  }

  function failNext(count = 1, error = new Error("feed unavailable")): void {
    failures = Array.from({ length: count }, () => error);
  }

  const fetchPage: RevokedSessionFeedFetcher = async (request) => {
    requests.push({ ...request });
    const failure = failures.shift();
    if (failure) throw failure;

    const cursor: FeedCursor = request.cursor
      ? (JSON.parse(request.cursor) as FeedCursor)
      : { scanStartedAt: now(), since: request.since, afterSeq: 0 };
    const at = now();
    const remaining = rows
      .filter(
        (row) =>
          row.recordedAt >= cursor.since &&
          row.seq > cursor.afterSeq &&
          row.expiresAt > at,
      )
      .sort((a, b) => a.seq - b.seq);
    const page = remaining.slice(0, pageSize);
    const isDone = remaining.length <= pageSize;
    const last = page[page.length - 1];
    const result: RevokedSessionFeedPage = {
      sessions: page.map(({ sid, expiresAt }) => ({ sid, expiresAt })),
      cursor: isDone
        ? null
        : JSON.stringify({
            ...cursor,
            afterSeq: last.seq,
          } satisfies FeedCursor),
      isDone,
      watermark: isDone ? cursor.scanStartedAt - overlapMs : null,
    };
    return result;
  };

  return { rows, requests, record, failNext, fetchPage };
}

export type FakeRevokedSessionFeed = ReturnType<
  typeof createRevokedSessionFeed
>;
