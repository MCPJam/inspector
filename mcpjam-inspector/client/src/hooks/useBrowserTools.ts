/**
 * What the agent browser adds to a turn, for the surfaces that show a host's
 * tools: the six `browser_*` tools MCPJam gives the model, and the WebMCP
 * tools the page it currently has open offers.
 *
 * WHY THIS EXISTS. The Tools pane lists what a host can do, and the browser
 * capability was invisible in it — a host with `browser` attached showed "No
 * server connected yet" while the model was driving a real Chromium. The
 * tools are built at turn time inside a chat request, so no store or Convex
 * row holds them; asking the server for the definitions is the only way to
 * show them without keeping a hand-written copy that drifts.
 *
 * ENGINE-BLIND TO THE CALLER. Which browser this is (the member's cloud
 * computer or the Chromium on their own machine) changes the transport and one
 * sentence of the tool descriptions, and nothing else — so the caller passes a
 * project and a host config, and reads one answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useBrowserEngine } from "@/hooks/useBrowserEngine";
import { useBrowserToolIds } from "./useBrowserToolIds";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { useHost } from "@/hooks/useClients";
import { resolveEffectiveHost } from "@/lib/effective-client";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import {
  useMintBrowserToken,
  useMintConversationBrowserToken,
} from "@/hooks/useProjectComputer";
import {
  createBrowserTokenCache,
  type MintBrowserToken,
} from "@/lib/hosted-browser/client";
import {
  fetchBrowserToolDefinitions,
  fetchHostedPageToolInvoke,
  fetchHostedPageTools,
  fetchLocalPageToolInvoke,
  fetchLocalPageTools,
} from "@/lib/browser-page-tools/client";
import type {
  BrowserPageToolInvokeResponse,
  BrowserPageToolsResponse,
} from "@/shared/browser-page-tools";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";
import { BROWSER_BUILT_IN_TOOL_ID } from "@/shared/client-fulfilled-tools";
import { usePaneHolderId } from "@/lib/local-browser/pane-holder";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import {
  browserPageToolsKey,
  useLiveWebmcpSignal,
  useWebmcpEpoch,
} from "@/stores/browser-page-tools-store";

/** How many times to re-read after a lease blocks the catalog. */
const LEASE_HELD_RETRIES = 3;

/**
 * Definitions are static per engine, so one fetch serves every mount for the
 * rest of the session — the pane is remounted every time somebody switches
 * rail tabs, and re-fetching a constant on each of those is noise on the wire
 * and a flicker in the list.
 */
const DEFINITIONS_CACHE = new Map<string, SerializedModelRequestTool[]>();

export interface BrowserToolsState {
  /** True when the previewed host actually attaches the browser capability. */
  attached: boolean;
  /** Which browser a call would drive. */
  engine: "hosted" | "local";
  /** The `browser_*` tools, as the model is shown them. */
  tools: SerializedModelRequestTool[];
  /**
   * The current page's WebMCP tools, or why they could not be read. `null`
   * while the first read is in flight, so the pane can stay quiet rather than
   * flashing "no browser running" at a browser that is starting.
   */
  page: BrowserPageToolsResponse | null;
  /**
   * The daemon's own change signal for this page's tools, when a browser
   * stream is open. Absent means "no news", never "no tools".
   */
  live?: { revision: number; hash: string; count: number; url?: string };
  /** Re-read the page. The definitions never change; only this does. */
  refreshPage: () => void;
  /**
   * Run a page tool the pane is showing, the way the WebMCP Inspector does.
   * `browser_*` verbs are not on this path.
   */
  invokePage: (args: {
    rawName: string;
    frameId?: string;
    input: Record<string, unknown>;
  }) => Promise<BrowserPageToolInvokeResponse>;
}

export function useBrowserTools(args: {
  projectId: string | null;
  /**
   * The EXPLICITLY previewed host, or null when the user has not picked one.
   *
   * Resolved here rather than taken as a list of ids, so a caller needs one
   * hook rather than a Convex subscription plus a host lookup plus this — the
   * browser is one capability, and asking about it should be one question.
   * `useHost` short-circuits on a null id, so this is cheap when nothing is
   * picked.
   */
  hostId: string | null;
}): BrowserToolsState {
  const { isAuthenticated } = useConvexAuth();
  const { host } = useHost({ isAuthenticated, hostId: args.hostId });
  // THE PROJECT DEFAULT, and the reason this hook cannot key on the previewed
  // id alone. "Which host is this surface operating under" is explicit-pick
  // ELSE project-default everywhere else in the app (`resolveEffectiveHost`),
  // and the Browser pane in the right rail resolves it that way — so a hook
  // that stopped at the explicit pick reported "no browser" for a project
  // whose DEFAULT host has one, which is the common case: the pane offered a
  // live browser while the Tools panel beside it said no server was connected.
  // `shouldQueryProjectId`, not a bare truthiness check. This hook's
  // `projectId` is the PLAYGROUND'S project scope, which falls back to the
  // local `activeProjectId` when there is no cloud project (PlaygroundTab
  // passes `sharedProjectId ?? activeProjectId`). That fallback is the string
  // sentinel `"none"` for a guest, which is truthy and reached
  // `v.id("projects")` — a validator that throws BEFORE the handler runs, so
  // nothing downstream could catch it. Sentry CONVEX-HQ: 636 users.
  const projectDefaultHostConfig = useQuery(
    "hostConfigsV2:getProjectDefault" as never,
    isAuthenticated && shouldQueryProjectId(args.projectId)
      ? ({ projectId: args.projectId } as never)
      : "skip",
  ) as HostConfigDtoV2 | null | undefined;
  const hostConfig = resolveEffectiveHost({
    explicitHostConfig: host?.config ?? null,
    projectDefaultHostConfig: projectDefaultHostConfig ?? null,
  });
  const engineState = useBrowserEngine(args.projectId);
  const mintToken = useMintBrowserToken();
  const mintConversationToken = useMintConversationBrowserToken();
  // THE CONVERSATION the Browser pane is driving. Chat ensures
  // `<project>:session:<id>`; a read that omits it still looks at the legacy
  // project-wide Chromium, which is why this list stayed empty while the
  // model was already calling the page's tools.
  const conversationId = useActiveChatSessionStore((state) => state.sessionId);
  // THE SAME HOLDER the Browser pane acquires under. Without it a hold that
  // is ours — a click that took the page, a leftover parked lease — makes
  // this list say someone else has the browser, while the model can still
  // call the tools after the next hand-back.
  const paneHolder = usePaneHolderId();
  const toolIds = useBrowserToolIds(hostConfig, engineState.selectedEngine);
  const attached = (toolIds ?? []).includes(
    BROWSER_BUILT_IN_TOOL_ID,
  );
  // The BODY-side engine choice, exactly as the Browser pane resolves it, so
  // the pane and the tool list cannot describe two different browsers.
  const engine: "hosted" | "local" =
    engineState.selectedEngine === "local" ? "local" : "hosted";
  const consentToken = engineState.consent.token;

  const [tools, setTools] = useState<SerializedModelRequestTool[]>(
    () => DEFINITIONS_CACHE.get(engine) ?? [],
  );
  const [page, setPage] = useState<BrowserPageToolsResponse | null>(null);
  const liveKey = browserPageToolsKey(args.projectId, engine);
  const webmcpEpoch = useWebmcpEpoch(liveKey);
  const live = useLiveWebmcpSignal(liveKey);
  const [pageNonce, setPageNonce] = useState(0);
  const refreshPage = useCallback(() => setPageNonce((n) => n + 1), []);

  /**
   * One token cache per project, mirroring the hosted pane's reasoning: the
   * token names the computer it authorizes, so carrying one across a project
   * switch would present another project's computer's credential.
   */
  const tokens = useMemo(() => {
    if (engine !== "hosted" || !args.projectId || !isAuthenticated) return null;
    const projectId = args.projectId;
    const mint: MintBrowserToken = conversationId
      ? () =>
          mintConversationToken({
            projectId,
            conversationId,
          })
      : () => mintToken({ projectId });
    return createBrowserTokenCache(mint);
  }, [
    engine,
    args.projectId,
    isAuthenticated,
    mintToken,
    mintConversationToken,
    conversationId,
  ]);
  /**
   * The cache, readable from the page effect WITHOUT being one of its
   * dependencies.
   *
   * `tokens` is derived, so its identity is only as stable as `mintToken`'s —
   * and an effect that re-runs on a new cache object also re-reads the page,
   * which sets state, which renders again. One unstable dependency upstream
   * turns a tool list into an unbounded request loop against a metered box.
   * The effect keys on the stable facts instead (project, engine, consent,
   * and an explicit refresh), and reaches the cache through here.
   */
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  /** Whether a hosted read is possible at all — a boolean, so it can be a dep. */
  const hostedReadable = tokens !== null;

  // Definitions. Cached per engine for the session; a failure leaves the list
  // empty rather than surfacing an error, because a pane that cannot describe
  // the browser is still a working pane.
  useEffect(() => {
    if (!attached) {
      setTools([]);
      return;
    }
    const cached = DEFINITIONS_CACHE.get(engine);
    if (cached) {
      setTools(cached);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    fetchBrowserToolDefinitions(engine, controller.signal)
      .then((items) => {
        DEFINITIONS_CACHE.set(engine, items);
        if (!cancelled) setTools(items);
      })
      .catch(() => {
        if (!cancelled) setTools([]);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attached, engine]);

  /**
   * The page read, which is a live look at a running browser.
   *
   * NEVER STARTS ONE. Both routes read an existing session and answer
   * `no_browser_session` when there is none — a tool list must not be what
   * provisions a cloud box or opens a window on somebody's desk.
   */
  const latestRead = useRef(0);
  useEffect(() => {
    if (!attached || !args.projectId) {
      setPage(null);
      return;
    }
    if (engine === "local" && !consentToken) {
      // Not an error: the local browser cannot be read until the person has
      // authorized this machine, and the Browser pane is where they do that.
      setPage({ ok: false, error: "no_browser_session" });
      return;
    }
    const cache = tokensRef.current;
    if (engine === "hosted" && !cache) {
      setPage(null);
      return;
    }
    const controller = new AbortController();
    const serial = (latestRead.current += 1);
    const projectId = args.projectId;
    // THE TAB THE SIGNAL CAME FROM. The heartbeat measures the ACTIVE tab, so
    // a read sent without one observes `@session` — a literal key, not
    // "whichever tab is active" — and the pane would show the default tab's
    // definitions, labelled live, beside a view of the tab the person is
    // actually in. Absent (an older daemon, a beat with no `tabs`) the read
    // falls back to today's behaviour rather than guessing.
    const signalTabId = live?.tabId;
    const read =
      engine === "hosted" && cache
        ? fetchHostedPageTools(cache, controller.signal, signalTabId)
        : fetchLocalPageTools(
            {
              projectId,
              ...(conversationId ? { sessionId: conversationId } : {}),
              ...(paneHolder ? { holder: paneHolder } : {}),
              ...(signalTabId ? { tabId: signalTabId } : {}),
            },
            consentToken,
            controller.signal,
          );
    read
      .then((answer) => {
        if (latestRead.current === serial) setPage(answer);
      })
      .catch(() => {
        // An aborted read is a superseded read, not a failure — leave whatever
        // the newer one is about to set.
        if (latestRead.current === serial && !controller.signal.aborted) {
          setPage({ ok: false, error: "unreachable" });
        }
      });
    return () => controller.abort();
    // `hostedReadable` rather than `tokens`: the boolean changes only when a
    // hosted read becomes possible or stops being, while the object it stands
    // for can churn on every render. See `tokensRef`.
  }, [
    attached,
    args.projectId,
    conversationId,
    paneHolder,
    engine,
    consentToken,
    hostedReadable,
    pageNonce,
    // LIVE. The daemon's heartbeat carries a `{revision, hash, count}` change
    // signal, and this epoch moves exactly when the page's tool set does — so
    // the list follows the model's navigation instead of going stale the
    // moment it matters. It is not a poll: an unchanged page never moves this,
    // and re-reading the page on a timer would be an observation with side
    // effects on the thing it observes.
    //
    // AND IT COVERS `live.tabId`, which the read above uses. `live` itself is
    // deliberately NOT a dependency: it moves on a URL-only beat too, and a
    // client-side route change leaves every registration in place — depending
    // on it would refetch definitions the pane already has, on every such
    // change. The store folds the tab into the equality that bumps this
    // epoch, so a tab that moves moves this and a URL that moves does not.
    webmcpEpoch,
  ]);

  /**
   * A hold is often a blink — takeover, chat handoff, a command in flight.
   * The catalog used to keep the refusal forever because the tool set itself
   * did not change, so the live signal never bumped the epoch. A few retries
   * cover the blink; a hold that lasts is still named after the last one.
   */
  const leaseHeldTries = useRef(0);
  useEffect(() => {
    leaseHeldTries.current = 0;
  }, [webmcpEpoch, conversationId]);
  useEffect(() => {
    if (!page || page.ok || page.error !== "lease_held") {
      leaseHeldTries.current = 0;
      return;
    }
    if (leaseHeldTries.current >= LEASE_HELD_RETRIES) return;
    const attempt = (leaseHeldTries.current += 1);
    const timer = window.setTimeout(
      () => setPageNonce((n) => n + 1),
      400 * attempt,
    );
    return () => window.clearTimeout(timer);
  }, [page]);

  const invokePage = useCallback(
    async (call: {
      rawName: string;
      frameId?: string;
      input: Record<string, unknown>;
    }): Promise<BrowserPageToolInvokeResponse> => {
      if (!attached || !call.rawName) {
        return { ok: false, error: "no_browser_session" };
      }
      const signalTabId = live?.tabId;
      if (engine === "hosted") {
        const cache = tokensRef.current;
        if (!cache) return { ok: false, error: "no_browser_session" };
        return fetchHostedPageToolInvoke(cache, {
          toolKey: call.rawName,
          input: call.input,
          ...(call.frameId ? { frameId: call.frameId } : {}),
          ...(signalTabId ? { tabId: signalTabId } : {}),
        });
      }
      const projectId = args.projectId;
      if (!projectId) return { ok: false, error: "no_browser_session" };
      return fetchLocalPageToolInvoke(
        {
          projectId,
          toolKey: call.rawName,
          input: call.input,
          ...(conversationId ? { sessionId: conversationId } : {}),
          ...(paneHolder ? { holder: paneHolder } : {}),
          ...(call.frameId ? { frameId: call.frameId } : {}),
          ...(signalTabId ? { tabId: signalTabId } : {}),
        },
        consentToken,
      );
    },
    [
      attached,
      engine,
      args.projectId,
      conversationId,
      paneHolder,
      consentToken,
      live?.tabId,
    ],
  );

  const available =
    engine !== "local" ||
    (engineState.localAvailable && engineState.consent.granted);
  return {
    attached,
    engine,
    tools: available ? tools : [],
    page: available
      ? page
      : { ok: false as const, error: "no_browser_session" as const },
    live: available ? live : undefined,
    refreshPage,
    invokePage,
  };
}
