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
 */
import type { CdpLike } from "./webmcp-bridge";

export interface NavigationStop {
  /** What the stopped navigation asked for, once one was stopped. */
  stopped(): string | undefined;
  /** Stop watching. Never throws. */
  disarm(): Promise<void>;
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

/** One listener per session, since a session cannot remove one. */
const watches = new WeakMap<CdpLike, { current?: Watch }>();

/** Fail the watched navigation; let every other paused request go on. */
async function answer(
  cdp: CdpLike,
  slot: { current?: Watch },
  payload: unknown,
): Promise<void> {
  const paused = payload as {
    requestId?: string;
    frameId?: string;
    request?: { url?: string };
  };
  const watch = slot.current;
  const url = paused.request?.url ?? "";
  const stop =
    watch !== undefined &&
    watch.stopped === undefined &&
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

export async function armNavigationStop(
  cdp: CdpLike,
  target: string,
): Promise<NavigationStop> {
  let slot = watches.get(cdp);
  if (!slot) {
    const created: { current?: Watch } = {};
    cdp.on("Fetch.requestPaused", (payload) => {
      void answer(cdp, created, payload);
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
  await cdp.send("Fetch.enable", {
    patterns: [
      {
        urlPattern: `${target}*`,
        resourceType: "Document",
        requestStage: "Request",
      },
    ],
  });
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
