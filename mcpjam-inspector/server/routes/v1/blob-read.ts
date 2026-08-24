/**
 * Bounded reads of Convex storage blobs from a v1 route.
 *
 * Transcripts and per-turn span blobs are served to public callers by
 * fetching a signed storage URL and buffering it on a request thread. Both
 * the ceiling and the "we could not read it" reporting are load-bearing, so
 * they live in ONE place rather than being restated per route: the user
 * testing transcript read and the agent Playground trace/detail reads make
 * the same guarantees, and a second copy is how one of them quietly loses a
 * cap.
 */

/**
 * Read a response body as text, giving up once `maxBytes` have arrived.
 *
 * Returns `null` when the body is over the ceiling or cannot be streamed, so
 * the caller reports unavailability rather than a silent truncation — a blob
 * cut mid-array would either fail to parse or, worse, parse into a
 * conversation that stops early with no sign that it did.
 *
 * The counting is on RECEIVED bytes. Checking `content-length` instead would
 * miss the two cases that matter: a chunked response has no such header, and a
 * present one is a claim, not a measurement. The absent case is the dangerous
 * one — `Number(null)` is 0, which passes any `> MAX` test and would hand an
 * unbounded body to the parser.
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the transfer rather than draining a body we have already
        // decided not to use.
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetch a signed blob URL and parse it as JSON, within a timeout and a byte
 * ceiling.
 *
 * Returns `null` for EVERY failure mode — absent URL, non-2xx, over the cap,
 * unparseable, timed out. The caller must render that as an explicit
 * unavailability flag and never as an empty result: "they said nothing" and
 * "we could not fetch it" lead to opposite conclusions, and a consumer
 * reading only a count would act on the wrong one.
 */
export async function fetchJsonBlob(
  url: string | null | undefined,
  options: { timeoutMs: number; maxBytes: number },
): Promise<unknown | null> {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return null;
    const text = await readCapped(response, options.maxBytes);
    if (text === null) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
