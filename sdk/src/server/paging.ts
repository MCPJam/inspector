import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

const CURSOR_PREFIX = "mock-page:";

// base64url by hand: `Buffer` is Node only, and this module also runs on Workers.
// The cursor text is ASCII, so `btoa` and `atob` take it as it is.
const toBase64Url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromBase64Url(text: string): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    return atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return undefined; // not base64: not a cursor this server issued
  }
}

/** Cursors are opaque to a client; this one carries the offset of the next page. */
function encodeCursor(offset: number): string {
  return toBase64Url(`${CURSOR_PREFIX}${offset}`);
}

function decodeCursor(cursor: string): number | undefined {
  const text = fromBase64Url(cursor);
  if (text === undefined || !text.startsWith(CURSOR_PREFIX)) return undefined;
  const offset = Number(text.slice(CURSOR_PREFIX.length));
  return Number.isInteger(offset) && offset >= 0 ? offset : undefined;
}

export interface PageOptions {
  /** The error for a cursor this server did not issue; a plain invalid-params error when left out. */
  invalidCursor?: () => Error;
}

/**
 * One page of a list the server builds itself. Without a page size the whole
 * list is the page. A cursor the server did not issue is refused by name, so a
 * client that kept one from before the list changed starts it again.
 */
export function pageOf<T>(
  items: T[],
  cursor: string | undefined,
  pageSize: number | undefined,
  options: PageOptions = {}
): { items: T[]; nextCursor?: string } {
  if (pageSize === undefined) return { items };
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    if (decoded === undefined || decoded > items.length) {
      throw (
        options.invalidCursor?.() ??
        new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "That page cursor is not valid for this list. List again without a cursor."
        )
      );
    }
    offset = decoded;
  }
  const end = offset + pageSize;
  return {
    items: items.slice(offset, end),
    ...(end < items.length && { nextCursor: encodeCursor(end) }),
  };
}
