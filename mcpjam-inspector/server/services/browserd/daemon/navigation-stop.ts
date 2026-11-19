/**
 * Stop a top-level navigation at a page and hand its URL back. The request is
 * failed before it is sent, so that page never loads and its scripts never
 * run. A readiness run stops this way at MCPJam's OAuth callback, whose app
 * would otherwise move `code` and `state` out of the address bar first.
 *
 * At the request stage of the CDP Fetch domain, not `page.route`: an
 * authorization server reaches the callback through a redirect, and a route
 * handler only ever sees the first URL of a redirect chain.
 *
 * The URL goes back in the command's result envelope alone (`stoppedAt`); the
 * ledger, trace and mirror never record it.
 *
 * BEHIND THE EGRESS PROXY. A public-only browser reaches every site through a
 * proxy that asks for credentials (`local/egress-proxy.ts`), and Playwright's
 * own session answers that challenge. While this session's Fetch is enabled,
 * Chromium gives the challenge to it instead, and a session that does not
 * handle auth answers it with nothing: the page fails with
 * `net::ERR_INVALID_AUTH_CREDENTIALS` before it loads. Answering `Default`
 * does not pass it back to Playwright either. So with `proxyAuth`, this
 * session pauses every request (a pattern is the only way it is asked about a
 * request's challenge), answers the proxy's challenge itself, and refuses any
 * other: the proxy's credentials never go to a site.
 */
import type { CdpLike } from "./webmcp-bridge";

export interface NavigationStop {
  /** What the stopped navigation asked for, once one was stopped. */
  stopped(): string | undefined;
  /** Stop watching. Never throws. */
  disarm(): Promise<void>;
}

/** The egress proxy's own credentials, when the browser runs behind it. */
export interface ProxyCredentials {
  username: string;
  password: string;
}

/** A page this stop may watch: an http(s) URL with no Fetch wildcard in it. */
export function isStopTarget(value: unknown): value is string {
  if (typeof value !== "string" || /[*?\\#]/.test(value)) return false;
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    // Not a URL at all, so not a page to stop at.
    return false;
  }
}

/** The page itself, whatever its query: not a longer path that shares it. */
const isAt = (url: string, target: string) =>
  url === target ||
  url.startsWith(`${target}?`) ||
  url.startsWith(`${target}#`);

interface Watch {
  target: string;
  mainFrame?: string;
  stopped?: string;
}

interface Slot {
  current?: Watch;
  proxyAuth?: ProxyCredentials;
  /** Requests already given the proxy's credentials: a second ask is a refusal. */
  answered: Set<string>;
}

/** One listener per session, since a session cannot remove one. */
const watches = new WeakMap<CdpLike, Slot>();

/** Bounds `answered`: past this many, a request has long since finished. */
const ANSWERED_LIMIT = 512;

/** Fail the watched navigation; let every other paused request go on. */
async function answer(
  cdp: CdpLike,
  slot: Slot,
  payload: unknown,
): Promise<void> {
  const paused = payload as {
    requestId?: string;
    frameId?: string;
    resourceType?: string;
    request?: { url?: string };
  };
  const watch = slot.current;
  const url = paused.request?.url ?? "";
  const stop =
    watch !== undefined &&
    watch.stopped === undefined &&
    paused.resourceType === "Document" &&
    paused.frameId === watch.mainFrame &&
    isAt(url, watch.target);
  if (stop) watch.stopped = url;
  try {
    await cdp.send(
      stop ? "Fetch.failRequest" : "Fetch.continueRequest",
      stop
        ? { requestId: paused.requestId, errorReason: "Aborted" }
        : { requestId: paused.requestId },
    );
  } catch {
    // The request went with its page, or the session closed: nothing waits.
  }
}

/**
 * The egress proxy's challenge gets its credentials, once per request; any
 * other challenge, and a second ask (the proxy refused them), is cancelled.
 */
async function answerAuth(
  cdp: CdpLike,
  slot: Slot,
  payload: unknown,
): Promise<void> {
  const challenge = payload as {
    requestId?: string;
    authChallenge?: { source?: string };
  };
  const requestId = challenge.requestId ?? "";
  const credentials = slot.proxyAuth;
  const provide =
    credentials !== undefined &&
    challenge.authChallenge?.source === "Proxy" &&
    !slot.answered.has(requestId);
  if (provide) {
    if (slot.answered.size >= ANSWERED_LIMIT) slot.answered.clear();
    slot.answered.add(requestId);
  }
  try {
    await cdp.send("Fetch.continueWithAuth", {
      requestId,
      authChallengeResponse: provide
        ? {
            response: "ProvideCredentials",
            username: credentials.username,
            password: credentials.password,
          }
        : { response: "CancelAuth" },
    });
  } catch {
    // The request went with its page, or the session closed: nothing waits.
  }
}

export async function armNavigationStop(
  cdp: CdpLike,
  target: string,
  proxyAuth?: ProxyCredentials,
): Promise<NavigationStop> {
  let slot = watches.get(cdp);
  if (!slot) {
    const created: Slot = { answered: new Set() };
    cdp.on("Fetch.requestPaused", (payload) => {
      void answer(cdp, created, payload);
    });
    cdp.on("Fetch.authRequired", (payload) => {
      void answerAuth(cdp, created, payload);
    });
    watches.set(cdp, created);
    slot = created;
  }
  const tree = (await cdp.send("Page.getFrameTree")) as {
    frameTree?: { frame?: { id?: string } };
  };
  const watch: Watch = { target, mainFrame: tree.frameTree?.frame?.id };
  const owner = slot;
  owner.current = watch;
  owner.proxyAuth = proxyAuth;
  await cdp.send(
    "Fetch.enable",
    proxyAuth
      ? {
          handleAuthRequests: true,
          patterns: [{ urlPattern: "*", requestStage: "Request" }],
        }
      : {
          patterns: [
            {
              urlPattern: `${target}*`,
              resourceType: "Document",
              requestStage: "Request",
            },
          ],
        },
  );
  return {
    stopped: () => watch.stopped,
    disarm: async () => {
      if (owner.current === watch) owner.current = undefined;
      try {
        await cdp.send("Fetch.disable");
      } catch {
        // A closed page has no interception left to turn off.
      }
    },
  };
}
