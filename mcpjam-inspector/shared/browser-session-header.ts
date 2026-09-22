/**
 * The header that carries which durable browser session an archive or a frame
 * came from.
 *
 * A constant rather than a literal in five places because a header name is a
 * CONTRACT between two sides that cannot typecheck each other: the server sets
 * it (computer-browser-panel, routes/mcp/computers) and the client reads it
 * (BrowserPanel, hosted-browser, local-browser). A typo on either side is not
 * a compile error, it is a silently absent value and a "save profile" button
 * that quietly stops knowing what it is saving.
 */
export const BROWSER_SESSION_ID_HEADER = "x-browser-session-id";

/**
 * The one shape of a profile-archive download, so the two routes that serve one
 * cannot drift.
 *
 * `savedFrom` names the durable browser session the archive was taken from, and
 * is omitted rather than sent empty — a client reads its absence as "this
 * archive is not tied to a session", which an empty string would not say.
 */
export function browserProfileArchiveResponse(
  archive: Uint8Array,
  savedFrom?: string,
): Response {
  // The view itself, NOT `Buffer.from(archive)`: that copies, and this archive
  // runs to 256 MB. `Response` will copy the body once regardless; there is no
  // reason to pay for it twice.
  return new Response(archive as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-disposition": "attachment; filename=browser-profile.tar.gz",
      ...(savedFrom ? { [BROWSER_SESSION_ID_HEADER]: savedFrom } : {}),
    },
  });
}
