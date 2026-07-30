/**
 * Keeps `/playground?conversation=<chatSessionId>` in step with the live chat
 * session, and reopens that conversation when the page loads with one.
 *
 * Two effects, deliberately kept apart:
 *
 * - **sync** writes the active session id into the URL once the transcript has
 *   content, so a refresh — or the full-page navigation an OAuth redirect
 *   performs — has something to come back to; and
 * - **restore** reads the id on load and hands it to the caller's fetch-and-
 *   hydrate callback.
 *
 * The invariant tying them together is *restored ⇔ `chatSessionId === param`*.
 * That is what makes this survive the chat hook re-minting its session id when
 * auth or the project scope resolves late: the ids diverge again, the restore
 * re-fires under the new scope, and the sync effect stands down while it does
 * (see {@link isConversationRestoreOutstanding}) instead of stripping the param
 * out from under it.
 *
 * Clearing is never inferred from an empty transcript — only an explicit reset
 * clears, via the returned `clearConversation`. Reset and the chat hook's
 * auth-bootstrap wipe look identical from here, and guessing wrong on the
 * second one loses the user's conversation.
 */

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { UNSAFE_LocationContext } from "react-router";

import { useAppNavigate } from "@/lib/app-navigation";
import {
  decideConversationUrlSync,
  isConversationRestoreOutstanding,
  PLAYGROUND_CONVERSATION_PARAM,
  readConversationParam,
} from "@/lib/playground-conversation-url";

/**
 * Current location, read from the router when there is one.
 *
 * Mirrors `useActiveTab` in `app-navigation.ts`: the context is read directly
 * rather than through `useSearchParams` so the hook shape stays unconditional
 * and the Playground still mounts in component tests that render without a
 * `<MemoryRouter>`. Outside a router we track `window.location` and re-read it
 * on `popstate`, which is also what `navigateApp`'s history fallback emits.
 */
function useRouterLocation(): { pathname: string; search: string } {
  const locationContext = useContext(UNSAFE_LocationContext);
  const contextLocation = locationContext?.location;
  const [fallback, setFallback] = useState(() =>
    typeof window === "undefined"
      ? { pathname: "", search: "" }
      : { pathname: window.location.pathname, search: window.location.search },
  );

  useLayoutEffect(() => {
    if (contextLocation || typeof window === "undefined") return;
    const sync = () =>
      setFallback({
        pathname: window.location.pathname,
        search: window.location.search,
      });
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [contextLocation]);

  if (contextLocation) {
    return {
      pathname: contextLocation.pathname,
      search: contextLocation.search,
    };
  }
  return fallback;
}

/**
 * Outcome of a restore attempt.
 *
 * `unavailable` is terminal for that id (deleted, archived away, or owned by
 * someone else) and clears the URL; `failed` is transient (network, a backend
 * blip) and leaves the param in place so a later scope change can retry.
 */
export type ConversationRestoreOutcome = "restored" | "unavailable" | "failed";

export type PlaygroundConversationUrl = {
  /** True while a restore is in flight — feed this into the loading overlay. */
  isRestoringConversation: boolean;
  /** Drop the conversation from the URL and storage (explicit New Chat). */
  clearConversation: () => void;
};

export function usePlaygroundConversationUrl(options: {
  /** Disabled on surfaces that are not the routed Playground (eval preview). */
  enabled: boolean;
  chatSessionId: string;
  hasMessages: boolean;
  /** The chat hook's auth-ready gate; fetching before this 401s. */
  isSessionBootstrapComplete: boolean;
  isStreaming: boolean;
  projectId: string | null | undefined;
  /** Compare lanes keep their own sessions; the URL tracks the single pane. */
  isMultiModelLayoutMode: boolean;
  /** An eval handoff is about to seed its own transcript — it wins. */
  isEvalHandoffPending: boolean;
  /** A thread picked from the rail is already hydrating; don't race it. */
  activeHistorySessionId: string | null;
  restoreConversation: (
    chatSessionId: string,
  ) => Promise<ConversationRestoreOutcome>;
}): PlaygroundConversationUrl {
  const {
    enabled,
    chatSessionId,
    hasMessages,
    isSessionBootstrapComplete,
    isStreaming,
    projectId,
    isMultiModelLayoutMode,
    isEvalHandoffPending,
    activeHistorySessionId,
    restoreConversation,
  } = options;

  const navigate = useAppNavigate();
  const { pathname, search } = useRouterLocation();
  const rawParamValue = useMemo(() => readConversationParam(search), [search]);

  /**
   * The conversation the user has explicitly walked away from (New Chat),
   * masked until the URL catches up.
   *
   * `resetChat` empties the transcript and mints a new session id immediately,
   * but dropping the param is a *navigation* — React Router runs it as a
   * transition, so it can commit a render later. For that one render the stale
   * param sits next to an empty transcript, which is exactly the signature of
   * "conversation waiting to be reopened" — and New Chat was undone by an
   * instant re-fetch off the history cache. Masking the id makes it invisible
   * to both effects for precisely as long as it is stale.
   */
  const [clearedParam, setClearedParam] = useState<string | null>(null);
  const paramValue =
    clearedParam !== null && rawParamValue === clearedParam
      ? null
      : rawParamValue;

  const [isRestoringConversation, setIsRestoringConversation] = useState(false);

  // Ids that will never restore under a given scope. Scoped, because a 404
  // against `projectId: null` can legitimately succeed once the real project
  // resolves — the same id under a new scope deserves one more try.
  const failedRestoresRef = useRef(new Set<string>());
  const restoreInFlightRef = useRef(false);
  const restoreConversationRef = useRef(restoreConversation);
  restoreConversationRef.current = restoreConversation;
  const paramValueRef = useRef(paramValue);
  paramValueRef.current = paramValue;

  const scopeKey = projectId ?? "local";
  const failureKey = useCallback(
    (id: string) => `${scopeKey}:${id}`,
    [scopeKey],
  );

  // `replace` throughout: the conversation id is a property of where the user
  // already is, not a place they navigated to. Pushing would make Back walk
  // through every session id the pane has held.
  const writeParam = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(search);
      mutate(params);
      const nextSearch = params.toString();
      navigate(nextSearch ? `${pathname}?${nextSearch}` : pathname, {
        replace: true,
      });
    },
    [navigate, pathname, search],
  );

  const clearConversation = useCallback(() => {
    // Masked synchronously; the navigation below only catches up later.
    setClearedParam(paramValueRef.current);
    writeParam((params) => params.delete(PLAYGROUND_CONVERSATION_PARAM));
  }, [writeParam]);

  const writeConversation = useCallback(
    (conversationId: string) => {
      writeParam((params) =>
        params.set(PLAYGROUND_CONVERSATION_PARAM, conversationId),
      );
    },
    [writeParam],
  );

  const restoreOutstanding =
    enabled &&
    isConversationRestoreOutstanding({
      paramValue,
      chatSessionId,
      hasMessages,
      hasFailed:
        paramValue !== null &&
        failedRestoresRef.current.has(failureKey(paramValue)),
    });

  // Written through refs: a restore hydrates the transcript, which re-mints
  // `chatSessionId` and re-runs this effect while the fetch is still awaiting.
  // Reading the callbacks at completion time keeps that mid-flight re-render
  // from applying a stale search string.
  const writeConversationRef = useRef(writeConversation);
  writeConversationRef.current = writeConversation;
  const clearConversationRef = useRef(clearConversation);
  clearConversationRef.current = clearConversation;

  // Restore. Declared before the sync effect so a re-armed restore (after the
  // chat hook re-mints its id) is already in flight when sync next evaluates.
  //
  // Not gated on compare mode: an explicit conversation id should open exactly
  // as it does from the history rail, which drops the compare grid for the
  // restored thread rather than ignoring the request.
  useEffect(() => {
    if (!enabled) return;
    if (!isSessionBootstrapComplete) return;
    if (isStreaming) return;
    if (isEvalHandoffPending) return;
    if (activeHistorySessionId) return;
    if (hasMessages) return;
    if (restoreInFlightRef.current) return;

    // The param is the ONLY source. Arriving at a bare `/playground` — the
    // sidebar link, a fresh window — starts a new chat rather than reopening
    // whatever was last on screen.
    const desiredId = paramValue;
    if (!desiredId) return;
    if (desiredId === chatSessionId) return;
    if (failedRestoresRef.current.has(failureKey(desiredId))) return;

    restoreInFlightRef.current = true;
    setIsRestoringConversation(true);

    void (async () => {
      try {
        const outcome = await restoreConversationRef.current(desiredId);
        if (outcome === "restored") return;
        // Both non-success outcomes stop this id from re-firing under the
        // current scope; only a terminal one gives up the URL.
        failedRestoresRef.current.add(failureKey(desiredId));
        // The URL can move on mid-fetch — the user navigates, or dismisses
        // this conversation outright. Clearing then would erase whatever they
        // moved to, so only give up the URL if it still asks for this id.
        const stillTargeted = paramValueRef.current === desiredId;
        if (outcome === "unavailable" && stillTargeted) {
          clearConversationRef.current();
        }
      } finally {
        restoreInFlightRef.current = false;
        setIsRestoringConversation(false);
      }
    })();
  }, [
    activeHistorySessionId,
    chatSessionId,
    enabled,
    failureKey,
    hasMessages,
    isEvalHandoffPending,
    isSessionBootstrapComplete,
    isStreaming,
    paramValue,
  ]);

  // Drop the mask as soon as the URL stops naming the cleared conversation —
  // it has either caught up, or the user has gone somewhere else. Without this
  // a later Back to that conversation would stay suppressed forever.
  useEffect(() => {
    if (clearedParam === null) return;
    if (rawParamValue === clearedParam) return;
    setClearedParam(null);
  }, [clearedParam, rawParamValue]);

  // Sync.
  useEffect(() => {
    if (!enabled) return;
    if (isMultiModelLayoutMode) return;
    const decision = decideConversationUrlSync({
      paramValue,
      chatSessionId,
      hasMessages,
      restorePending: restoreOutstanding || isRestoringConversation,
    });
    if (decision.kind !== "set") return;
    // Never put back the conversation the user just dismissed. Masking makes
    // it invisible to the restore effect; without this the sync effect would
    // read that same absence as "the URL is missing an id" and write it again.
    if (decision.conversationId === clearedParam) return;
    writeConversation(decision.conversationId);
  }, [
    clearedParam,
    chatSessionId,
    enabled,
    hasMessages,
    isMultiModelLayoutMode,
    isRestoringConversation,
    paramValue,
    restoreOutstanding,
    writeConversation,
  ]);

  return { isRestoringConversation, clearConversation };
}
