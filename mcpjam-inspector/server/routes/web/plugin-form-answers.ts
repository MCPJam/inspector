import { Hono } from "hono";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { mapWebBoundaryError } from "./boundary-error.js";
import { webErrorFromRoute } from "./errors.js";

export const PRIVATE_FORM_ANSWER_MAX_BYTES = 256 * 1024;
const forms = new Hono();

/** Fixed private backend destination; browser credentials never reach an arbitrary URL. */
forms.post("/answer-upload", async (c) => {
  c.header("cache-control", "no-store");
  try {
    const kind = c.req.query("kind");
    const id = c.req.query("id");
    const roundText = c.req.query("round");
    const round = Number(roundText);
    if (
      (kind !== "legacy" && kind !== "mrtr") ||
      !id?.trim() ||
      id.length > 4096 ||
      !roundText ||
      !/^\d+$/.test(roundText) ||
      !Number.isSafeInteger(round) ||
      (kind === "legacy" && round !== 0)
    )
      return c.json({ error: "Invalid private form answer scope" }, 400);
    if (
      c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    )
      return c.json({ error: "A JSON form answer is required" }, 415);
    const bearer = await getConvexBearerForRequest(c);
    const configured = process.env.CONVEX_HTTP_URL;
    if (!configured)
      return c.json({ error: "Private form storage is unavailable" }, 503);
    const url = new URL("/web/plugin-forms/answer-upload", configured);
    url.search = new URLSearchParams({
      kind,
      id,
      round: String(round),
    }).toString();
    const reader = c.req.raw.body?.getReader();
    if (!reader)
      return c.json({ error: "A JSON form answer is required" }, 400);
    // One deadline covers reading the browser body and the private backend exchange.
    const signal = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(15_000),
    ]);
    const cancelBody = () => {
      void reader.cancel(signal.reason).catch(() => {});
    };
    if (signal.aborted) cancelBody();
    else signal.addEventListener("abort", cancelBody, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > PRIVATE_FORM_ANSWER_MAX_BYTES) {
          await reader.cancel();
          return c.json({ error: "Private form answer is too large" }, 413);
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", cancelBody);
      reader.releaseLock();
    }
    signal.throwIfAborted();
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer.replace(/^Bearer\s+/i, "")}`,
      },
      body,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      const status = [400, 401, 403, 404, 409, 413, 415, 429].includes(
        response.status,
      )
        ? response.status
        : 502;
      return new Response(
        JSON.stringify({ error: "Private form answer was refused" }),
        {
          status,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        },
      );
    }
    const reply: unknown = await response.json().catch(() => null);
    const receipt = reply as { ok?: unknown; storageId?: unknown } | null;
    if (
      receipt?.ok !== true ||
      typeof receipt.storageId !== "string" ||
      !receipt.storageId.trim() ||
      receipt.storageId.length > 512
    )
      return c.json({ error: "Invalid private form storage receipt" }, 502);
    return c.json({ ok: true, storageId: receipt.storageId });
  } catch (error) {
    return webErrorFromRoute(c, mapWebBoundaryError(error));
  }
});

export default forms;
