/**
 * Reading the agent browser's tools from the client — the two things the Tools
 * pane needs, and the one difference between the engines.
 *
 *   1. The six `browser_*` tools MCPJam gives the model. Static, identical for
 *      every project, fetched from `/api/v1/built-in-tools/browser/definitions`
 *      so nothing here keeps a hand-written copy of schemas built at turn time.
 *   2. The WebMCP tools the PAGE currently offers, which is a live read of a
 *      running browser and therefore engine-specific: a signed browser token
 *      against the hosted panel, a consent capability against the local one.
 *
 * The two are separate calls because they answer different questions and fail
 * differently: the definitions are always available (they describe a
 * capability), while the page read has four distinct refusals a person needs
 * to be told apart.
 */
import { authFetch } from "@/lib/session-token";
import { LOCAL_CONSENT_HEADER } from "@/lib/local-computer-consent";
import type {
  BrowserPageToolsErrorCode,
  BrowserPageToolsResponse,
} from "@/shared/browser-page-tools";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";
import {
  HOSTED_BROWSER_BASE,
  type BrowserTokenCache,
} from "@/lib/hosted-browser/client";

/**
 * The `browser_*` definitions, as the model is shown them.
 *
 * Soft-fails to an empty list, like the harness catalog: a pane that cannot
 * reach the catalog should show no browser section, not an error over a
 * browser that is working.
 */
export async function fetchBrowserToolDefinitions(
  engine: "hosted" | "local",
  signal?: AbortSignal,
): Promise<SerializedModelRequestTool[]> {
  const res = await authFetch(
    `/api/v1/built-in-tools/browser/definitions?engine=${engine}`,
    signal ? { signal } : {},
  );
  if (!res.ok) throw new Error(`browser definitions ${res.status}`);
  const body = (await res.json()) as {
    items?: SerializedModelRequestTool[];
  };
  return Array.isArray(body.items) ? body.items : [];
}

/**
 * Normalize a page-tools response body, whatever the status was.
 *
 * The routes answer the SAME body shape on success and on every refusal, so a
 * caller never has to map a status code to a meaning — the code is in the
 * body. This exists for the one case that shape cannot cover: a response that
 * is not the route's at all (an HTML error page from a proxy, a dropped
 * connection), which becomes `unreachable`.
 */
function decodePageTools(body: unknown): BrowserPageToolsResponse {
  if (typeof body === "object" && body !== null && "ok" in body) {
    return body as BrowserPageToolsResponse;
  }
  return { ok: false, error: "unreachable" };
}

const UNREACHABLE: BrowserPageToolsResponse = {
  ok: false,
  error: "unreachable" as BrowserPageToolsErrorCode,
};

/** The hosted browser's page tools, via the panel's signed browser token. */
export async function fetchHostedPageTools(
  tokens: BrowserTokenCache,
  signal?: AbortSignal,
  /**
   * WHICH TAB to read, when the live signal named one.
   *
   * Omitted, the route observes `@session` — a literal tab key in the daemon,
   * not "whichever tab is active" — so a read that follows a signal from a
   * second tab would answer for the first.
   */
  tabId?: string,
): Promise<BrowserPageToolsResponse> {
  const query = tabId ? `?tabId=${encodeURIComponent(tabId)}` : "";
  const send = async (token: string) =>
    fetch(`${HOSTED_BROWSER_BASE}/page-tools${query}`, {
      headers: { authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    });
  const presented = await tokens.get();
  let res = await send(presented);
  if (res.status === 401) {
    // One retry with a fresh token, for the same reason the panel's own calls
    // do it: a cached token expiring mid-session is the normal way a long-open
    // pane meets a 401, and re-minting is the fix rather than an error.
    tokens.invalidateIf(presented);
    res = await send(await tokens.get());
  }
  return decodePageTools(await res.json().catch(() => null));
}

/** The local browser's page tools, via the device consent capability. */
export async function fetchLocalPageTools(
  args: { projectId: string; holder?: string; tabId?: string },
  consentToken: string | null,
  signal?: AbortSignal,
): Promise<BrowserPageToolsResponse> {
  const res = await authFetch("/api/mcp/computers/local-browser/page-tools", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(consentToken ? { [LOCAL_CONSENT_HEADER]: consentToken } : {}),
    },
    body: JSON.stringify(args),
    ...(signal ? { signal } : {}),
  });
  return decodePageTools(await res.json().catch(() => null));
}

export { UNREACHABLE as UNREACHABLE_PAGE_TOOLS };
