import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

const CURSOR_PREFIX = "mock-page:";

/** Cursors are opaque to a client; this one carries the offset of the next page. */
function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`).toString("base64url");
}

function decodeCursor(cursor: string): number | undefined {
  const text = Buffer.from(cursor, "base64url").toString();
  if (!text.startsWith(CURSOR_PREFIX)) return undefined;
  const offset = Number(text.slice(CURSOR_PREFIX.length));
  return Number.isInteger(offset) && offset >= 0 ? offset : undefined;
}

/**
 * One page of a list the mock builds itself. Without a page size the whole
 * list is the page. A cursor the mock did not issue is refused by name, so a
 * client that kept one from before an edit starts the list again.
 */
export function pageOf<T>(
  items: T[],
  cursor: string | undefined,
  pageSize: number | undefined
): { items: T[]; nextCursor?: string } {
  if (pageSize === undefined) return { items };
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    if (decoded === undefined || decoded > items.length) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        "That page cursor is not valid for this mock. List again without a cursor.",
        { mockCode: "mock_invalid_cursor" }
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
