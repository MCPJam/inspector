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
import { useConvexAuth } from "convex/react";
import { useComputerEngine } from "@/hooks/useComputerEngine";
import { useHost } from "@/hooks/useClients";
import { useMintBrowserToken } from "@/hooks/useProjectComputer";
import {
  createBrowserTokenCache,
  type MintBrowserToken,
} from "@/lib/hosted-browser/client";
import {
  fetchBrowserToolDefinitions,
  fetchHostedPageTools,
  fetchLocalPageTools,
} from "@/lib/browser-page-tools/client";
import type { BrowserPageToolsResponse } from "@/shared/browser-page-tools";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";
import { BROWSER_BUILT_IN_TOOL_ID } from "@/shared/client-fulfilled-tools";

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
  /** Re-read the page. The definitions never change; only this does. */
  refreshPage: () => void;
}

export function useBrowserTools(args: {
  projectId: string | null;
  /**
   * The previewed host. Resolved HERE rather than taken as a list of ids, so a
   * caller needs one hook rather than a Convex subscription plus a host lookup
   * plus this — the browser is one capability, and asking about it should be
   * one question. `useHost` short-circuits on a null id, so this is cheap when
   * no host is picked.
   */
  hostId: string | null;
}): BrowserToolsState {
  const { isAuthenticated } = useConvexAuth();
  const { host } = useHost({ isAuthenticated, hostId: args.hostId });
  const engineState = useComputerEngine(args.projectId);
  const mintToken = useMintBrowserToken();
  const attached = (host?.config?.builtInToolIds ?? []).includes(
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
    const mint: MintBrowserToken = () => mintToken({ projectId });
    return createBrowserTokenCache(mint);
  }, [engine, args.projectId, isAuthenticated, mintToken]);

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
    if (engine === "hosted" && !tokens) {
      setPage(null);
      return;
    }
    const controller = new AbortController();
    const serial = (latestRead.current += 1);
    const projectId = args.projectId;
    const read =
      engine === "hosted" && tokens
        ? fetchHostedPageTools(tokens, controller.signal)
        : fetchLocalPageTools({ projectId }, consentToken, controller.signal);
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
  }, [attached, args.projectId, engine, consentToken, tokens, pageNonce]);

  return { attached, engine, tools, page, refreshPage };
}
