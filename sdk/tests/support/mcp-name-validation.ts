/**
 * The `Mcp-Name` check a conforming 2026-07-28 server makes before it
 * dispatches a named request, written without the SDK's own encoder so a test
 * that uses it does not grade the encoder against itself.
 *
 * Returns the problem a server would refuse the request for, or `undefined`
 * when the header names the same target as the body.
 */
export function mcpNameProblem(
  header: string | null | undefined,
  bodyName: string
): string | undefined {
  if (header === null || header === undefined) {
    return "Missing Mcp-Name header";
  }
  if (!/^[\x20-\x7e]*$/.test(header)) {
    return "Mcp-Name has characters that are not visible ASCII";
  }
  const sentinel = /^=\?base64\?(.*)\?=$/.exec(header);
  const named = sentinel
    ? Buffer.from(sentinel[1], "base64").toString("utf8")
    : header;
  return named === bodyName ? undefined : "Mcp-Name header does not match";
}

/** The JSON-RPC error a server sends with HTTP 400 for a bad `Mcp-Name`. */
export function headerMismatchError(id: unknown, message: string) {
  return { jsonrpc: "2.0", id, error: { code: -32020, message } };
}

/** Names a raw copy into the header would get wrong, and why. */
export const NAMES_THAT_NEED_ENCODING: Array<[why: string, name: string]> = [
  ["is not plain ASCII", "hello-ñandú"],
  ["is outside Latin-1", "天気-tool"],
  ["looks like the Base64 sentinel", "=?base64?aGVsbG8=?="],
];
