/**
 * Public v1 chatbox reads.
 *
 * Thin pass-throughs over the Convex read surface's chatbox routes
 * (mcpjam-backend `convex/publicApi/routes.ts`: `/v1/chatboxes` and
 * `/v1/chatbox`) — the same pattern the eval reads use, with the bearer
 * swapped via `getConvexBearerForRequest` (the caller's JWT verbatim, or
 * the short-lived org-scoped delegated JWT minted for WorkOS API-key
 * callers). Convex enforces membership and the delegated org scope at its
 * own boundary, and both surfaces speak the same canonical envelope, so
 * the body and status are forwarded verbatim. The detail route additionally
 * cross-checks the chatbox's projectId against the path so a valid id from
 * another project reads as NOT_FOUND, matching the eval-read contract.
 */
import { Hono } from "hono";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { mapErrorToV1, v1Error } from "./envelope.js";

const chatboxes = new Hono();

const CONVEX_FORWARD_TIMEOUT_MS = 15_000;

async function forwardConvexV1Read(
  bearer: string,
  path: string,
  query: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new Error("Server missing CONVEX_HTTP_URL configuration");
  }
  const url = new URL(path, convexUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    CONVEX_FORWARD_TIMEOUT_MS
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        (error as { code?: string }).code === "ABORT_ERR");
    throw new Error(
      isAbort
        ? `Chatbox read timed out after ${CONVEX_FORWARD_TIMEOUT_MS}ms`
        : `Failed to reach backend for chatbox read: ${
            error instanceof Error ? error.message : String(error)
          }`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // Both surfaces share the canonical envelope, so any JSON body — resource,
  // page, or { code, message } error — forwards verbatim with its status.
  // A non-JSON body means the request never reached the v1 handler (e.g.
  // Convex routing 404 from a misconfigured CONVEX_HTTP_URL): surface as an
  // upstream failure, not as a caller error.
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (body === null) {
    throw new Error(
      `Backend chatbox read returned a non-JSON response (${response.status})`
    );
  }
  return { status: response.status, body };
}

// ── GET /v1/projects/:projectId/chatboxes ───────────────────────────

chatboxes.get("/projects/:projectId/chatboxes", async (c) => {
  const projectId = c.req.param("projectId");
  try {
    const bearer = await getConvexBearerForRequest(c);
    const { status, body } = await forwardConvexV1Read(
      bearer,
      "/v1/chatboxes",
      { projectId }
    );
    return c.json(body, status as any);
  } catch (error) {
    const mapped = mapErrorToV1(error);
    return v1Error(c, mapped.code, mapped.message, mapped.details);
  }
});

// ── GET /v1/projects/:projectId/chatboxes/:chatboxId ────────────────

chatboxes.get("/projects/:projectId/chatboxes/:chatboxId", async (c) => {
  const projectId = c.req.param("projectId");
  const chatboxId = c.req.param("chatboxId");
  try {
    const bearer = await getConvexBearerForRequest(c);
    const { status, body } = await forwardConvexV1Read(bearer, "/v1/chatbox", {
      chatboxId,
    });
    // Path cross-check, same as the eval reads: a real chatbox living in a
    // different project must read as NOT_FOUND under this path, not leak.
    if (status === 200 && String(body.projectId ?? "") !== projectId) {
      return v1Error(c, "NOT_FOUND", "Chatbox not found");
    }
    return c.json(body, status as any);
  } catch (error) {
    const mapped = mapErrorToV1(error);
    return v1Error(c, mapped.code, mapped.message, mapped.details);
  }
});

export default chatboxes;
