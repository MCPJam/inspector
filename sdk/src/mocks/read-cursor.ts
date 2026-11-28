/**
 * Cursors for the bounded reads. A cursor carries where the next page starts
 * and nothing else a reader could use: the data is read again, as the caller,
 * on every page. It is bound to the version the first page read (so an edit to
 * the head cannot change a read half way through), to the caller and mock, and
 * to the query. A cursor used by another caller or with another query is
 * refused by name; the hashes are a consistency check, not a secret, because
 * forging one only lets a caller page their own view from an offset.
 */
import { canonicalJson, sha256Hex } from "../contract/canonical.js";

export type MockCursorRefusal = "malformed" | "other_caller" | "other_query";

export class MockCursorError extends Error {
  constructor(
    readonly reason: MockCursorRefusal,
    message: string
  ) {
    super(message);
    this.name = "MockCursorError";
  }
}

export interface MockCursorBinding {
  /** The caller and the mock, as one string the host builds. */
  scope: string;
  /** What is being read: family, name, path and search. Not the page size. */
  query: unknown;
}

export interface MockCursorState {
  version: number;
  offset: number;
}

const digest = (value: string) => sha256Hex(value).slice(0, 16);

export function sealMockCursor(
  state: MockCursorState,
  binding: MockCursorBinding
): string {
  const body = {
    v: state.version,
    o: state.offset,
    s: digest(binding.scope),
    q: digest(canonicalJson(binding.query)),
  };
  return Buffer.from(JSON.stringify(body)).toString("base64url");
}

export function openMockCursor(
  cursor: string,
  binding: MockCursorBinding
): MockCursorState {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    body = undefined;
  }
  const { v, o, s, q } = (body ?? {}) as Record<string, unknown>;
  if (
    !Number.isInteger(v) ||
    (v as number) < 1 ||
    !Number.isInteger(o) ||
    (o as number) < 0 ||
    typeof s !== "string" ||
    typeof q !== "string"
  ) {
    throw new MockCursorError(
      "malformed",
      "That cursor is not one this server issued. Read again without a cursor."
    );
  }
  if (s !== digest(binding.scope)) {
    throw new MockCursorError(
      "other_caller",
      "That cursor was issued to another caller or for another mock. Read again without a cursor."
    );
  }
  if (q !== digest(canonicalJson(binding.query))) {
    throw new MockCursorError(
      "other_query",
      "That cursor belongs to a different read. Send it only with the family, name, path and search you read first, or read again without a cursor."
    );
  }
  return { version: v as number, offset: o as number };
}
