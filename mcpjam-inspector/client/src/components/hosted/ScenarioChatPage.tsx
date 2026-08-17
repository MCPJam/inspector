import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { track } from "@/lib/analytics";
import { Loader2, Link2Off, ShieldX } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { ChatTabV2 } from "@/components/ChatTabV2";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useApiContext } from "@/hooks/hosted/use-hosted-api-context";
import { useHostedOAuthGate } from "@/hooks/hosted/use-hosted-oauth-gate";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { authFetch } from "@/lib/session-token";
import {
  buildScenarioLink,
  clearScenarioSession,
  extractScenarioTokenFromPath,
  normalizeScenarioSession,
  readScenarioSurfaceFromUrl,
  readScenarioSession,
  SCENARIO_OAUTH_PENDING_KEY,
  scenarioEnabledOptionalStorageKey,
  slugify,
  type ScenarioSession,
  writeScenarioSession,
  writeScenarioSignInReturnPath,
} from "@/lib/scenario-session";
import type {
  HostedAccessErrorDetail,
  HostedAccessRecoveryResult,
} from "@/lib/hosted-runtime-context";
import { navigateApp } from "@/lib/app-navigation";
import {
  isEmbeddedPreview,
  syncScenarioBootstrapHash,
  syncScenarioSessionHash,
} from "@/lib/embedded-preview";
import { clearScenarioChatTranscript } from "@/lib/scenario-chat-transcript";
import { bootstrapServerToHostedOAuthDescriptor } from "@/lib/scenario-server-optional";
import { useHostedOAuthRequirements } from "@/hooks/hosted/use-hosted-oauth-requirements";
import { useScenarioTurnRating } from "@/hooks/useScenarioTurnRating";
import { HostedTurnRating } from "@/components/hosted/hosted-turn-rating";
import { useScenarioServerReachability } from "@/hooks/hosted/use-scenario-server-reachability";
import { isHostedOAuthBusy } from "@/lib/hosted-oauth-resume";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import {
  ScenarioChatUiOverrideProvider,
  ScenarioHostStyleProvider,
} from "@/contexts/scenario-client-style-context";
import { gateMcpToolResultImageRenderingByModelVisibility } from "@/lib/client-config-v2";
import { ScenarioHostCapabilitiesOverrideProvider } from "@/contexts/scenario-client-capabilities-override-context";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import { ActiveHostCapsResolverScope } from "@/contexts/active-host-client-capabilities-context";
import { ScenarioSurfaceProvider } from "@/contexts/scenario-surface-context";
import { WebManagedServersProvider } from "@/contexts/web-managed-servers-context";
import { ScenarioHostOnboardingOverlays } from "@/components/hosted/ScenarioHostOnboardingOverlays";
import { ScenarioUnreachableServersBanner } from "@/components/hosted/ScenarioUnreachableServersBanner";
import { useScenarioHostIntroGate } from "@/components/hosted/useScenarioHostIntroGate";
import {
  getScenarioHostLabel,
  getScenarioHostLogo,
  getScenarioShellStyle,
} from "@/lib/scenario-client-style";
import { DEFAULT_HOST_STYLE } from "@/lib/client-styles";

interface ScenarioChatPageProps {
  pathToken?: string | null;
  onExitScenarioChat?: () => void;
}

interface ScenarioRouteError {
  status: number;
  code?: string;
  message: string;
  rawMessage: string;
}

type ScenarioErrorKind =
  | "access_denied"
  | "guest_blocked"
  | "invalid_link"
  | "scenario_unavailable"
  | "unexpected";

interface ScenarioDisplayError {
  kind: ScenarioErrorKind;
  title: string;
  message: string;
}

/**
 * Visitor-facing copy on the public scenario runtime, and the reason none of it
 * names a product.
 *
 * Whoever reads these strings followed a link someone sent them. They are not
 * signed in to MCPJam, have never seen the dashboard, and "swarm" is a word
 * they have no referent for — it named the internal surface the link happened
 * to be created from. Worse, one `scenarios` row backs BOTH a Swarm and a User
 * Testing scenario (nothing on the row distinguishes them; `isDeliberateScenario`
 * infers it client-side), so on the User Testing surface the noun was outright
 * wrong: the author's own preview told them their scenario was a swarm.
 *
 * "Link" is what the visitor actually has, and it is true on every surface.
 * Keep it that way — reintroducing a product noun here means picking one of two
 * products for a reader who knows neither.
 */
const INVALID_SCENARIO_LINK_MESSAGE =
  "This link is invalid or expired. Ask whoever shared it for a new one if you still need access.";
const UNEXPECTED_SCENARIO_ERROR_MESSAGE =
  "We couldn't open this link right now. Please try again or open MCPJam.";

type ScenarioBootstrapAuthMode = "workos" | "guest";
type ScenarioLandingState =
  | "resolvingAuth"
  | "bootstrapping"
  | "ready"
  | "denied";

function sanitizeScenarioRouteErrorMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const withoutWrapper = normalized.replace(/^Uncaught Error:\s*/i, "");
  return withoutWrapper
    .replace(/\s+at\s+(?:async\s+)?[A-Za-z0-9_$./<>-]+(?:\s+\(|$).*/s, "")
    .trim();
}

function createScenarioRouteError(
  status: number,
  message: string,
  code?: string
): ScenarioRouteError {
  const fallbackMessage = `Request failed with status ${status}`;
  const rawMessage = message.trim() || fallbackMessage;
  const sanitizedMessage = sanitizeScenarioRouteErrorMessage(rawMessage);

  return {
    status,
    code,
    rawMessage,
    message: sanitizedMessage || fallbackMessage,
  };
}

async function readRouteError(response: Response): Promise<ScenarioRouteError> {
  const bodyText = await response.text();
  const trimmedBody = bodyText.trim();
  let code: string | undefined;
  let message = trimmedBody;

  try {
    const body = (trimmedBody ? JSON.parse(trimmedBody) : null) as {
      code?: string;
      message?: string;
      error?: string;
      details?: { code?: string } | null;
    } | null;

    // The DOMAIN code wins when the route forwarded one. Top-level `code` is
    // the transport classification (CONFLICT, NOT_FOUND…); `details.code`
    // says WHY — e.g. ENV_ARCHIVED, which is the difference between "this
    // link is broken" and "its owner retired it".
    const domainCode = body?.details?.code;
    code =
      typeof domainCode === "string" && domainCode
        ? domainCode
        : typeof body?.code === "string"
        ? body.code
        : undefined;
    message =
      body?.message ||
      body?.error ||
      trimmedBody ||
      `Request failed with status ${response.status}`;
  } catch {
    message = trimmedBody || `Request failed with status ${response.status}`;
  }

  return createScenarioRouteError(response.status, message, code);
}

function isScenarioRouteError(error: unknown): error is ScenarioRouteError {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number" &&
    "message" in error &&
    typeof error.message === "string" &&
    "rawMessage" in error &&
    typeof error.rawMessage === "string"
  );
}

function getScenarioDisplayError(
  error: ScenarioRouteError | null
): ScenarioDisplayError {
  if (!error) {
    return {
      kind: "invalid_link",
      title: "Link Unavailable",
      message: INVALID_SCENARIO_LINK_MESSAGE,
    };
  }

  const normalizedMessage = error.message.toLowerCase();
  const requiresSignIn = normalizedMessage.includes(
    "sign in to access this scenario"
  );
  // The code is authoritative when the route sent one; the substring checks
  // stay as the deploy-skew fallback for servers that predate the code.
  const isAccessDenied =
    error.code === "SCENARIO_ACCESS_DENIED" ||
    normalizedMessage.includes("don't have access");
  const isGuestBlocked =
    normalizedMessage.includes("guests cannot access") ||
    normalizedMessage.includes("guest access");
  const isInvalidLink =
    error.status === 404 ||
    error.code === "NOT_FOUND" ||
    normalizedMessage.includes("invalid or has expired") ||
    normalizedMessage.includes("invalid or expired");
  // The scenario exists and the link is valid — its environment just isn't
  // openable (archived by its owner, a disabled plugin, a deleted host). The
  // backend already authored visitor-facing copy for each case, so it is shown
  // verbatim rather than re-derived from a status code.
  const isScenarioUnavailable = Boolean(error.code?.startsWith("ENV_"));

  if (isScenarioUnavailable) {
    return {
      kind: "scenario_unavailable",
      title:
        error.code === "ENV_ARCHIVED"
          ? "This link has been archived"
          : "This link isn't available right now",
      message: error.message,
    };
  }

  if (requiresSignIn || isAccessDenied) {
    return {
      kind: "access_denied",
      title: "Access Denied",
      message: error.message,
    };
  }

  if (isGuestBlocked) {
    return {
      kind: "guest_blocked",
      title: "Access Denied",
      message: error.message,
    };
  }

  if (isInvalidLink) {
    return {
      kind: "invalid_link",
      title: "Link Unavailable",
      message: INVALID_SCENARIO_LINK_MESSAGE,
    };
  }

  return {
    kind: "unexpected",
    title: "Link Unavailable",
    message: UNEXPECTED_SCENARIO_ERROR_MESSAGE,
  };
}

/**
 * One round trip from share token to a validated session: /redeem exchanges
 * the link token for a `scenarioId` + `accessVersion` grant plus the bootstrap
 * payload. Every scenario-aware backend call then keys on the resolved
 * identity — the URL token is never threaded onto the read path.
 *
 * Shared by the mount bootstrap and by re-redeem recovery so both agree on
 * validation: the response is untrusted shape until `normalizeScenarioSession`
 * enforces every field `ScenarioBootstrapPayload` requires. Without that, a
 * partial bootstrap would be persisted and the API context downstream would
 * initialize with `null`s.
 *
 * Throws a `ScenarioRouteError` on any failure, so callers can classify the
 * refusal (denied vs transient) off `status`/`code`.
 */
async function redeemScenarioToken(
  token: string,
  options?: {
    /**
     * Surface to stamp on the produced session instead of re-deriving it
     * from the URL. Recovery passes the mounted session's surface: the
     * post-redeem strip removes the query string in the standalone page, so
     * a URL re-read mid-session would quietly demote a preview session to
     * `share_link` on the request wire.
     */
    surface?: ScenarioSession["surface"];
  }
): Promise<ScenarioSession> {
  const redeemResponse = await authFetch("/api/web/scenarios/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioToken: token }),
  });

  if (!redeemResponse.ok) {
    throw await readRouteError(redeemResponse);
  }

  const redeemed = (await redeemResponse.json()) as {
    scenarioId?: unknown;
    accessVersion?: unknown;
    bootstrap?: unknown;
  };

  const nextSession = normalizeScenarioSession({
    scenarioId:
      typeof redeemed.scenarioId === "string" ? redeemed.scenarioId : undefined,
    accessVersion:
      typeof redeemed.accessVersion === "number"
        ? redeemed.accessVersion
        : undefined,
    payload: redeemed.bootstrap as ScenarioSession["payload"] | undefined,
    surface:
      options?.surface ?? readScenarioSurfaceFromUrl(window.location.search),
    // Stamped so recovery has a way back to a grant after the post-redeem
    // strip removes the token from the URL.
    shareToken: token,
  });

  if (!nextSession) {
    throw createScenarioRouteError(
      502,
      "Scenario redeem returned an incomplete bootstrap payload."
    );
  }

  return nextSession;
}

function getScenarioBootstrapAuthMode(
  isAuthenticated: boolean
): ScenarioBootstrapAuthMode {
  return isAuthenticated ? "workos" : "guest";
}

function isInteractiveSignInRequired(kind: ScenarioErrorKind): boolean {
  return kind === "access_denied" || kind === "guest_blocked";
}

export function ScenarioChatPage({
  pathToken,
  onExitScenarioChat,
}: ScenarioChatPageProps) {
  const {
    getAccessToken,
    signIn,
    user: workOsUser,
    isLoading: isWorkOsLoading,
  } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const themeMode = usePreferencesStore((s) => s.themeMode);

  // The embedded Preview iframe is same-origin, so it shares the tab's
  // sessionStorage with the outer dashboard. Reading or writing the scenario
  // session from inside the embed would leak it into (or pick it up from)
  // the host app — the outer App treats a stored session as "render the
  // scenario runtime", hijacking the dashboard on the next reload. The embed
  // never needs the fallback anyway: its URL keeps the share token (the
  // post-redeem strip only runs standalone), so a reload re-redeems.
  const readCurrentSession = useCallback(() => {
    return isEmbeddedPreview() ? null : readScenarioSession();
  }, []);

  const writeCurrentSession = useCallback((nextSession: ScenarioSession) => {
    if (isEmbeddedPreview()) {
      return;
    }

    writeScenarioSession(nextSession);
  }, []);

  /**
   * Drop the grant AND the tester's resumable transcript for it. Access loss is
   * terminal here (`handleHostedAccessRevoked`, or a redeem that no longer
   * resolves), so leaving the conversation in sessionStorage would offer a
   * resume for a scenario this visitor can no longer reach. Takes the scenario
   * id explicitly because the session it belongs to is being torn down in the
   * same breath.
   */
  const clearCurrentSession = useCallback((scenarioId?: string | null) => {
    if (isEmbeddedPreview()) {
      return;
    }

    if (scenarioId) {
      clearScenarioChatTranscript(scenarioId);
    }
    clearScenarioSession();
  }, []);

  const [session, setSession] = useState<ScenarioSession | null>(() =>
    readCurrentSession()
  );
  const [isBootstrapping, setIsBootstrapping] = useState(Boolean(pathToken));
  const [routeError, setRouteError] = useState<ScenarioRouteError | null>(null);
  const interactiveSignInEventKeyRef = useRef<string | null>(null);
  const tokenFromPath = useMemo(() => pathToken?.trim() || null, [pathToken]);
  // Mirror `tokenFromPath` into a ref so async work (the silent re-redeem
  // below) can detect a mid-flight navigation: when the user switches
  // scenario tokens before the in-flight `/api/web/scenarios/redeem`
  // response arrives, the resolved-but-stale session must not overwrite
  // the new token's active session.
  const tokenFromPathRef = useRef(tokenFromPath);
  useEffect(() => {
    tokenFromPathRef.current = tokenFromPath;
  }, [tokenFromPath]);
  // Render-assigned (NOT effect-assigned) mirror of the resolved session, so
  // async recovery reads the live share token instead of a one-render-stale
  // one. The token is the ONLY way back to a grant once the post-redeem strip
  // has removed it from the URL.
  const sessionRef = useRef<ScenarioSession | null>(session);
  sessionRef.current = session;
  // Lifetime latch for async recovery: a re-redeem that resolves after this
  // page unmounted must not write sessionStorage (which outlives the page and
  // would hijack the next mount with a resurrected session).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  // The token still in the URL when there is one, else the token the redeem
  // persisted onto the session. Post-strip these are the same value, which is
  // precisely what keeps the staleness guards below from discarding every
  // refresh forever; navigating to a DIFFERENT scenario still trips them.
  const resolveShareToken = useCallback(
    () => tokenFromPathRef.current ?? sessionRef.current?.shareToken ?? null,
    []
  );
  const isAuthSettling =
    Boolean(tokenFromPath) && (isWorkOsLoading || isAuthLoading);

  const sessionServersRequired = useMemo(
    () => session?.payload.servers.filter((s) => !s.optional) ?? [],
    [session]
  );

  const sessionServersOptional = useMemo(
    () => session?.payload.servers.filter((s) => s.optional) ?? [],
    [session]
  );

  const [enabledOptionalServerIds, setEnabledOptionalServerIds] = useState<
    string[]
  >([]);

  useEffect(() => {
    if (!session?.scenarioId) return;
    try {
      const raw = sessionStorage.getItem(
        scenarioEnabledOptionalStorageKey(session.scenarioId)
      );
      if (!raw) {
        setEnabledOptionalServerIds((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const optionalIdSet = new Set(
        session.payload.servers.filter((s) => s.optional).map((s) => s.serverId)
      );
      const next = parsed.filter(
        (id): id is string => typeof id === "string" && optionalIdSet.has(id)
      );
      setEnabledOptionalServerIds((prev) => {
        if (
          prev.length === next.length &&
          prev.every((id, i) => id === next[i])
        ) {
          return prev;
        }
        return next;
      });
    } catch {
      setEnabledOptionalServerIds((prev) => (prev.length === 0 ? prev : []));
    }
    // Intentionally only re-hydrate when the scenario id changes — not when
    // `payload.servers` gets a new array identity on each render.
  }, [session?.scenarioId]);

  useEffect(() => {
    if (!session?.scenarioId) return;
    try {
      const key = scenarioEnabledOptionalStorageKey(session.scenarioId);
      const serialized = JSON.stringify(enabledOptionalServerIds);
      if (sessionStorage.getItem(key) === serialized) return;
      sessionStorage.setItem(key, serialized);
    } catch {
      // ignore
    }
  }, [session?.scenarioId, enabledOptionalServerIds]);

  const sessionServersActive = useMemo(() => {
    if (!session) return [];
    const enabled = new Set(enabledOptionalServerIds);
    const optionalActive = session.payload.servers.filter(
      (s) => s.optional && enabled.has(s.serverId)
    );
    return [...sessionServersRequired, ...optionalActive];
  }, [session, sessionServersRequired, enabledOptionalServerIds]);

  // Does the recipient actually have to authorize anything? The bootstrap
  // payload only carries `useOAuth`, a compat mirror that is also true for an
  // `auto` (discover) server — gating on it is what asked recipients to
  // authorize servers with no authorization server at all. The probe answers
  // from the canonical `authMethod`.
  const oauthRequirementByServerId = useHostedOAuthRequirements(
    sessionServersActive,
    !!session
  );

  const oauthServers = useMemo(
    () =>
      sessionServersActive.map((server) => {
        const descriptor = bootstrapServerToHostedOAuthDescriptor(server);
        const requirement = oauthRequirementByServerId[server.serverId];
        return {
          ...descriptor,
          // A server enters the gate only once the probe has answered for it.
          // The gate seeds its status map the first time it sees a server and
          // then preserves that status across rebuilds, so admitting a server
          // while the answer is still "checking" would freeze it as satisfied
          // and the panel would never appear for a real OAuth server.
          useOAuth:
            descriptor.useOAuth &&
            (requirement === "required" || requirement === "not_required"),
          // Still in the authorizable set either way: a "no" only means "do not
          // prompt up front", and a genuine 401 later still routes through
          // `markOAuthRequired` and gets its Authorize action.
          authorizationRequiredUpfront: requirement === "required",
        };
      }),
    [sessionServersActive, oauthRequirementByServerId]
  );

  const requiredOAuthServers = useMemo(
    () => oauthServers.filter((server) => !server.optional),
    [oauthServers]
  );

  const handleEnableScenarioOptionalServer = useCallback((serverId: string) => {
    setEnabledOptionalServerIds((prev) =>
      prev.includes(serverId) ? prev : [...prev, serverId]
    );
  }, []);

  const scenarioOptionalInventory = useMemo(() => {
    const enabled = new Set(enabledOptionalServerIds);
    return sessionServersOptional
      .filter((s) => !enabled.has(s.serverId))
      .map((s) => ({
        serverId: s.serverId,
        serverName: s.serverName,
        useOAuth: s.useOAuth,
      }));
  }, [sessionServersOptional, enabledOptionalServerIds]);
  const {
    pendingOAuthServers,
    authorizeServer,
    markOAuthRequired,
    hasBusyOAuth,
  } = useHostedOAuthGate({
    surface: "scenario",
    pendingKey: SCENARIO_OAUTH_PENDING_KEY,
    servers: oauthServers,
    projectId: session?.payload.projectId ?? null,
    scenarioId: session?.scenarioId,
    isAuthenticated,
  });

  // Only servers the OAuth machinery never touches. Every `useOAuth` row —
  // including a discover-mode one, which the mirror also reports as true — is
  // the gate's: it verifies them against this same /validate endpoint, and a
  // row that is merely waiting for consent, or that answers 401 until it gets
  // it, is not an unreachable server. Probing those here would double-connect
  // and mislabel them.
  const reachabilityCandidates = useMemo(
    () => sessionServersActive.filter((server) => !server.useOAuth),
    [sessionServersActive]
  );

  const reachabilityCandidateIds = useMemo(
    () => new Set(reachabilityCandidates.map((server) => server.serverId)),
    [reachabilityCandidates]
  );

  // Scoped to the scenario, not to `accessVersion`: a re-redeem mid-session
  // bumps the version without changing which servers this tester is exercising,
  // and re-probing there would shut the composer again on every recovery.
  const reachabilityByServerId = useScenarioServerReachability(
    reachabilityCandidates,
    !!session,
    session?.scenarioId ?? null
  );

  const scenarioServerConfigs = useMemo(() => {
    if (!session) return {};

    return Object.fromEntries(
      sessionServersActive.map((server) => {
        // Reported: a scenario whose only server never connected ran a full
        // session with a green dot next to it. This map drives the composer's
        // server list, so a server that did not answer must not claim it did —
        // including on the renders before its probe has even registered, which
        // is why a candidate with no entry yet reads as still connecting.
        // Servers owned by the OAuth gate are never probed and keep the
        // optimistic status the gate's own flow depends on.
        const reachability =
          reachabilityByServerId[server.serverId] ??
          (reachabilityCandidateIds.has(server.serverId)
            ? "checking"
            : undefined);
        const connectionStatus =
          reachability === "unreachable"
            ? "failed"
            : reachability === "checking"
              ? "connecting"
              : "connected";

        return [
          server.serverName,
          {
            name: server.serverName,
            config: {
              url: "https://scenario-chat.invalid",
            } as any,
            lastConnectionTime: new Date(),
            connectionStatus,
            retryCount: 0,
            enabled: true,
          } satisfies ServerWithName,
        ];
      })
    );
  }, [
    session,
    sessionServersActive,
    reachabilityByServerId,
    reachabilityCandidateIds,
  ]);

  const reachableSessionServerIds = useMemo(
    () =>
      sessionServersActive
        .filter(
          (server) => reachabilityByServerId[server.serverId] !== "unreachable"
        )
        .map((server) => server.serverId),
    [sessionServersActive, reachabilityByServerId]
  );

  const unreachableServerNames = useMemo(
    () =>
      sessionServersActive
        .filter(
          (server) => reachabilityByServerId[server.serverId] === "unreachable"
        )
        .map((server) => server.serverName),
    [sessionServersActive, reachabilityByServerId]
  );

  // Sending before the probes answer is the silent failure in a new outfit: a
  // server still being checked is withheld from the turn, so the model would
  // answer with none of the tools the tester was sent here to exercise. A
  // candidate with no entry has not been probed yet either — the hook records
  // "checking" from an effect, so the first render after a session resolves has
  // an empty map and would otherwise open the composer on unprobed servers.
  const isCheckingServerReachability = useMemo(
    () =>
      reachabilityCandidates.some(
        (server) =>
          (reachabilityByServerId[server.serverId] ?? "checking") === "checking"
      ),
    [reachabilityCandidates, reachabilityByServerId]
  );

  const hostedServerIdsByName = useMemo(() => {
    if (!session) return {};

    return Object.fromEntries(
      sessionServersActive.flatMap((server) => [
        [server.serverName, server.serverId],
        [server.serverId, server.serverId],
      ])
    );
  }, [session, sessionServersActive]);

  useApiContext({
    projectId: session?.payload.projectId ?? null,
    serverIdsByName: session ? hostedServerIdsByName : {},
    getAccessToken,
    // Resolved scenario identity from /api/web/scenarios/redeem. Both
    // fields live at the top level of the session — the URL token is
    // never threaded onto the read path.
    scenarioId: session?.scenarioId,
    accessVersion: session?.accessVersion,
    isAuthenticated: !!workOsUser,
    hasSession: !!workOsUser || isWorkOsLoading,
  });

  useEffect(() => {
    if (isAuthSettling) {
      return;
    }

    let cancelled = false;

    const resolve = async () => {
      if (tokenFromPath) {
        const authMode = getScenarioBootstrapAuthMode(isAuthenticated);
        setIsBootstrapping(true);
        setRouteError(null);
        track("scenario_bootstrap_started", {
          location: "scenario",
          surface: "scenario",
          auth_mode: authMode,
          status: "started",
        });
        try {
          const nextSession = await redeemScenarioToken(tokenFromPath);
          if (cancelled) return;

          writeCurrentSession(nextSession);
          setSession(nextSession);
          setRouteError(null);

          syncScenarioBootstrapHash(slugify(nextSession.payload.name));
          track("scenario_bootstrap_silent_success", {
            location: "scenario",
            surface: "scenario",
            auth_mode: authMode,
            status: "success",
          });
        } catch (error) {
          if (cancelled) return;
          setSession(null);
          clearCurrentSession(sessionRef.current?.scenarioId ?? null);

          const nextError = isScenarioRouteError(error)
            ? error
            : createScenarioRouteError(
                500,
                error instanceof Error
                  ? error.message
                  : "Unable to open this scenario."
              );
          const displayError = getScenarioDisplayError(nextError);

          if (displayError.kind === "unexpected") {
            console.error("[ScenarioChatPage] Failed to bootstrap scenario", {
              status: nextError.status,
              code: nextError.code,
              message: nextError.message,
              rawMessage: nextError.rawMessage,
            });
          }

          setRouteError(nextError);
          track("scenario_bootstrap_silent_failure", {
            location: "scenario",
            surface: "scenario",
            auth_mode: authMode,
            status: "failure",
            error_kind: displayError.kind,
            http_status: nextError.status,
          });
        } finally {
          if (!cancelled) {
            setIsBootstrapping(false);
          }
        }
        return;
      }

      const recovered = readCurrentSession();
      if (recovered) {
        setSession(recovered);
        setRouteError(null);
        syncScenarioBootstrapHash(slugify(recovered.payload.name));
        return;
      }

      setSession(null);
      setRouteError(
        createScenarioRouteError(404, "Invalid or expired scenario link")
      );
    };

    void resolve();

    return () => {
      cancelled = true;
    };
  }, [
    clearCurrentSession,
    isAuthenticated,
    isAuthSettling,
    readCurrentSession,
    tokenFromPath,
    writeCurrentSession,
  ]);

  // Re-redeem path. Callers reach it when the backend reports the caller's
  // access is stale or refused: the capture hook on `scenario_access_stale`,
  // and the chat turn on a SCENARIO_ACCESS_STALE / SCENARIO_ACCESS_DENIED
  // response. It re-runs /web/scenario/redeem against the share token and
  // updates `session` in place, which propagates a fresh `accessVersion` to
  // every downstream consumer.
  //
  // It re-redeems on DENIED too, not just stale: /redeem re-MINTS the grant
  // for an `anyone_with_link` scenario, so a refusal caused by guest-identity
  // rotation or a mode round-trip is recoverable. Only a redeem that itself
  // fails definitively is terminal.
  //
  // The in-flight latch is keyed by *token* and holds the PROMISE, not a
  // boolean: concurrent callers (N chat lanes plus the capture backoff) all
  // await the same /redeem round trip instead of each minting a grant. A
  // navigation that swaps the token from A to B while A's redeem is still
  // pending must not block B from starting its own — A's response is
  // discarded by the staleness guards anyway, so leaving B with no refresh
  // in flight would strand the capture hook's queued stale snapshot.
  const refreshInFlightRef = useRef<{
    token: string;
    promise: Promise<HostedAccessRecoveryResult>;
  } | null>(null);
  const refreshAccessSession =
    useCallback(async (): Promise<HostedAccessRecoveryResult> => {
      const token = resolveShareToken();
      if (!token) {
        return { ok: false, reason: "no_token" };
      }
      const inFlight = refreshInFlightRef.current;
      if (inFlight && inFlight.token === token) {
        return inFlight.promise;
      }

      const promise = (async (): Promise<HostedAccessRecoveryResult> => {
        try {
          const nextSession = await redeemScenarioToken(token, {
            surface: sessionRef.current?.surface,
          });
          // Guards before mutating shared session state: a navigation to a
          // different scenario between the request and now would install
          // another scenario's session over the active one, and an unmount
          // (the visitor left the page, or the exit path just CLEARED the
          // stored session) must not resurrect a session the page no longer
          // owns — sessionStorage outlives this component.
          if (!isMountedRef.current || resolveShareToken() !== token) {
            return { ok: false, reason: "transient" };
          }
          writeCurrentSession(nextSession);
          setSession(nextSession);
          return { ok: true, accessVersion: nextSession.accessVersion };
        } catch (error) {
          const routeError = isScenarioRouteError(error)
            ? error
            : createScenarioRouteError(
                0,
                error instanceof Error
                  ? error.message
                  : "Unable to refresh scenario access."
              );
          const detail = {
            status: routeError.status,
            code: routeError.code,
            message: routeError.message,
          };
          // Only a definitive refusal is terminal. Everything else — a 429
          // from the redeem rate limiter, a 5xx, a dropped connection —
          // leaves the mounted chat alone and gets another attempt on the
          // next send.
          const isDefinitive =
            routeError.status === 401 ||
            routeError.status === 403 ||
            routeError.status === 404 ||
            routeError.status === 410;
          if (!isDefinitive) {
            console.warn(
              "[ScenarioChatPage] Scenario re-redeem failed transiently",
              detail
            );
          }
          return isDefinitive
            ? { ok: false, reason: "denied", error: detail }
            : { ok: false, reason: "transient", error: detail };
        } finally {
          // Only clear the latch if we're still the active in-flight
          // refresh. A newer token's refresh may have already overwritten
          // it; don't stomp on that one.
          if (refreshInFlightRef.current?.token === token) {
            refreshInFlightRef.current = null;
          }
        }
      })();

      refreshInFlightRef.current = { token, promise };
      return promise;
    }, [resolveShareToken, writeCurrentSession]);

  // Fire-and-forget wrapper kept for `useSharedChatWidgetCapture`, whose
  // contract is a void call it never awaits.
  const requestRefreshAccessVersion = useCallback(() => {
    void refreshAccessSession();
  }, [refreshAccessSession]);

  // Terminal access loss: recovery ran and this visitor still cannot reach
  // the scenario. Drop the session so `landingState` computes "denied" and
  // the landing panel (Sign in / Open in App) replaces the runtime, rather
  // than leaving a generic banner over a chat that can no longer send.
  const handleHostedAccessRevoked = useCallback(
    (error: HostedAccessErrorDetail) => {
      setSession(null);
      clearCurrentSession(sessionRef.current?.scenarioId ?? null);
      setRouteError(
        createScenarioRouteError(error.status, error.message, error.code)
      );
    },
    [clearCurrentSession]
  );

  const displayError = useMemo(
    () => getScenarioDisplayError(routeError),
    [routeError]
  );
  const landingState: ScenarioLandingState = isAuthSettling
    ? "resolvingAuth"
    : isBootstrapping
    ? "bootstrapping"
    : session
    ? "ready"
    : "denied";

  useEffect(() => {
    if (
      landingState !== "denied" ||
      isAuthenticated ||
      !isInteractiveSignInRequired(displayError.kind)
    ) {
      interactiveSignInEventKeyRef.current = null;
      return;
    }

    const authMode = getScenarioBootstrapAuthMode(isAuthenticated);
    const eventKey = `${displayError.kind}:${authMode}:${
      routeError?.status ?? 0
    }`;
    if (interactiveSignInEventKeyRef.current === eventKey) {
      return;
    }

    interactiveSignInEventKeyRef.current = eventKey;
    track("interactive_signin_required", {
      location: "scenario",
      surface: "scenario",
      auth_mode: authMode,
      status: "required",
      error_kind: displayError.kind,
      http_status: routeError?.status,
    });
  }, [displayError.kind, isAuthenticated, landingState, routeError?.status]);

  useEffect(() => {
    if (!session) return;

    const expectedHash = slugify(session.payload.name);
    const enforceHash = () => {
      syncScenarioSessionHash(expectedHash);
    };

    enforceHash();
    window.addEventListener("hashchange", enforceHash);
    return () => {
      window.removeEventListener("hashchange", enforceHash);
    };
  }, [session]);

  const shareableToken = tokenFromPath ?? session?.shareToken?.trim() ?? null;

  const handleCopyLink = useCallback(async () => {
    // Token preference: live URL → persisted `session.shareToken`. After
    // redeem we strip the token from the address bar via replaceState,
    // so `session.shareToken` (captured at redeem time) is what makes
    // Copy link work across reloads.
    const token = shareableToken;
    if (!session || !token) {
      toast.error("Link unavailable");
      return;
    }

    if (!navigator.clipboard?.writeText) {
      toast.error("Copy is not available in this browser");
      return;
    }

    try {
      await navigator.clipboard.writeText(
        buildScenarioLink(token, session.payload.name)
      );
      toast.success("Link copied");
    } catch {
      toast.error("Failed to copy link");
    }
  }, [session, shareableToken]);

  const handleOpenMcpJam = useCallback(() => {
    clearScenarioSession();
    // Route via the navigation API so React Router's `useLocation`
    // (consumed by App's pathname-sync effect) sees the new pathname.
    // A bare `window.history.replaceState` would leave `locationForRoute`
    // stale on `/scenario/...`, and the sync effect would then redirect
    // back to `/servers` before the hash-migration shim could pivot.
    navigateApp("/scenarios", {
      replace: isEmbeddedPreview() ? true : true,
    });
    onExitScenarioChat?.();
  }, [onExitScenarioChat]);

  const handleSignIn = useCallback(() => {
    writeScenarioSignInReturnPath(window.location.pathname);
    signIn();
  }, [signIn]);

  const handleOAuthRequired = useCallback(
    (details?: HostedOAuthRequiredDetails) => {
      markOAuthRequired(details);
    },
    [markOAuthRequired]
  );

  // Before the redeem resolves we don't know which host this scenario
  // emulates. Seeding "claude" made every tester watch a Claude-branded shell
  // load a Cursor scenario; DEFAULT_HOST_STYLE is MCPJam precisely so
  // unresolved surfaces don't impersonate a vendor.
  //
  // A stored session is no proof of that either. sessionStorage outlives the
  // page, so a tester who opens a second link redeems scenario B with scenario
  // A's session still in hand, and the shell wears A's brand for the whole
  // redemption — the same impersonation, sourced from the last visit instead of
  // a seed. The session earns the shell only once its own share token is the
  // one in the address bar; with no token there (the post-redeem strip removed
  // it) the stored session is all there is, and it is this link's.
  const sessionForCurrentLink =
    tokenFromPath && session?.shareToken !== tokenFromPath ? null : session;
  const hostStyle =
    sessionForCurrentLink?.payload.hostStyle ?? DEFAULT_HOST_STYLE.id;
  const chatUiOverride = sessionForCurrentLink?.payload.chatUiOverride;
  const shellStyle = getScenarioShellStyle(hostStyle, themeMode, chatUiOverride);
  const clientLabel = getScenarioHostLabel(hostStyle, chatUiOverride);
  const clientLogoSrc = getScenarioHostLogo(
    hostStyle,
    chatUiOverride,
    themeMode
  );
  const oauthPending = pendingOAuthServers.length > 0;
  const welcomeAvailable =
    (session?.payload.chatUi?.surfaces?.welcome?.enabled ?? true) &&
    !!session?.payload.chatUi?.surfaces?.welcome?.body?.trim();

  // Per-turn ratings. OFF unless the scenario explicitly enabled them — the
  // backend default is `false`, so this whole surface is inert on every
  // existing scenario until a PM flips the editor toggle.
  const perTurnFeedback = session?.payload.chatUi?.surfaces?.perTurnFeedback;
  const perTurnFeedbackEnabled = perTurnFeedback?.enabled === true;
  const turnRating = useScenarioTurnRating({
    enabled: perTurnFeedbackEnabled,
    scenarioId: session?.scenarioId,
    accessVersion: session?.accessVersion,
    // The style picks the score key. Derived here rather than inside the hook
    // so the widget's `variant` and the key its clicks write both come from
    // one read of the config.
    scoreKey:
      perTurnFeedback?.style === "thumbs" ? "user_thumb" : "user_rating",
    onStaleHostedAccess: requestRefreshAccessVersion,
  });
  const introGate = useScenarioHostIntroGate({
    scenarioId: session?.payload.scenarioId ?? "",
    // The probed descriptors, not the raw bootstrap rows: the gate asks "does
    // this session require authorization", which the payload's `useOAuth`
    // mirror cannot answer (see `oauthServers` above).
    servers: requiredOAuthServers,
    oauthPending,
    hasBusyOAuth,
    pendingOAuthServers,
    welcomeAvailable,
  });
  const isFinishingOAuth =
    pendingOAuthServers.length > 0 &&
    pendingOAuthServers.every(({ state }) => isHostedOAuthBusy(state.status));

  const renderContent = () => {
    if (landingState === "resolvingAuth" || landingState === "bootstrapping") {
      return (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (landingState === "denied") {
      const isAccessDenied = displayError.kind === "access_denied";
      const guestBlocked = displayError.kind === "guest_blocked";

      return (
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
            <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              {isAccessDenied || guestBlocked ? (
                <ShieldX className="h-5 w-5 text-muted-foreground" />
              ) : (
                <Link2Off className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
            <h2 className="text-base font-semibold text-foreground">
              {displayError.title}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {displayError.message}
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              {/* No sign-in CTA inside the author's Preview embed. `signIn()`
                  navigates THIS frame to WorkOS and returns to
                  `/oauth/callback`, outside the `main.tsx` self-embed
                  exemption, so the frame lands on `IframeRouterError` — the
                  author is offered a button that cannot complete. Standalone
                  visitors keep it; it works there. */}
              {!isAuthenticated &&
              (isAccessDenied || guestBlocked) &&
              !isEmbeddedPreview() ? (
                <Button onClick={handleSignIn}>Sign in</Button>
              ) : null}
              <Button variant="outline" onClick={handleOpenMcpJam}>
                Open in App
              </Button>
            </div>
          </div>
        </div>
      );
    }

    if (!session) {
      return null;
    }

    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <ScenarioUnreachableServersBanner serverNames={unreachableServerNames} />
        <ChatTabV2
          connectedOrConnectingServerConfigs={scenarioServerConfigs}
          selectedServerNames={sessionServersActive.map(
            (server) => server.serverName
          )}
          minimalMode
          showContextPopover
          reasoningDisplayMode="hidden"
          hostedContext={{
            scenarioId: session.scenarioId,
            accessVersion: session.accessVersion,
            scenarioSurface: session.surface ?? "share_link",
            projectId: session.payload.projectId,
            // `hostedContext.selectedServerIds` wins over the status-filtered
            // names inside ChatTabV2, so a server proven unreachable has to be
            // dropped HERE or the turn still ships it. Sending it anyway costs
            // the whole turn: one server that fails `listTools` rejects the
            // Promise.all behind the tool set. The tester already has the
            // banner saying why it's missing.
            selectedServerIds: reachableSessionServerIds,
            requestRefreshAccessVersion,
            refreshAccessSession,
            onAccessRevoked: handleHostedAccessRevoked,
            // Redeemed sessions carry Convex-resolved server ids; only the
            // web chat engine can connect them.
            requiresWebChatApi: true,
          }}
          executionConfig={{
            modelId: session.payload.modelId,
            systemPrompt: session.payload.systemPrompt,
            temperature: session.payload.temperature,
            requireToolApproval: session.payload.requireToolApproval,
            modelVisibleMcpToolResults:
              session.payload.modelVisibleMcpToolResults,
            mcpToolResultImageRendering:
              gateMcpToolResultImageRenderingByModelVisibility(
                session.payload.mcpToolResultImageRendering,
                session.payload.modelVisibleMcpToolResults
              ),
          }}
          onOAuthRequired={handleOAuthRequired}
          scenarioComposerBlocked={
            introGate.composerBlocked || isCheckingServerReachability
          }
          scenarioComposerBlockedReason={
            introGate.composerBlocked
              ? "Get started or authorize to send messages…"
              : "Connecting to this session's tools…"
          }
          scenarioOptionalInventory={scenarioOptionalInventory}
          onEnableScenarioOptionalServer={handleEnableScenarioOptionalServer}
          renderAssistantTurnActions={
            perTurnFeedbackEnabled && perTurnFeedback
              ? ({ chatSessionId, turnId }) => (
                  <HostedTurnRating
                    chatSessionId={chatSessionId}
                    turnId={turnId}
                    config={perTurnFeedback}
                    rating={turnRating}
                  />
                )
              : undefined
          }
        />
        <ScenarioHostOnboardingOverlays
          showWelcome={introGate.showWelcome}
          onGetStarted={introGate.dismissIntro}
          welcomeBody={session.payload.chatUi?.surfaces?.welcome?.body}
          showAuthPanel={introGate.showAuthPanel}
          pendingOAuthServers={pendingOAuthServers}
          authorizeServer={authorizeServer}
          isFinishingOAuth={isFinishingOAuth}
          onSkipAuthorization={introGate.dismissAuthPanel}
        />
      </div>
    );
  };

  return (
    <ScenarioHostStyleProvider value={hostStyle}>
      <ScenarioChatUiOverrideProvider value={chatUiOverride}>
        <ScenarioHostCapabilitiesOverrideProvider
          value={session?.payload.hostCapabilitiesOverride}
        >
          <ActiveMcpProfileProvider value={session?.payload.mcpProfile}>
            {/*
        Hosted bootstrap payload doesn't (yet) carry clientCapabilities —
        we pass `activeHost={null}` and let the scope fall back to the
        template seed for `hostStyle`. Correct for unmodified host styles;
        if a scenario owner customizes capabilities, that will require a
        bootstrap-payload extension (out of scope here).
      */}
            <ActiveHostCapsResolverScope
              activeHost={null}
              hostStyle={hostStyle}
            >
              <ScenarioSurfaceProvider value={true}>
                {/* Redeemed sessions: servers are Convex-resolved, so MCP
                    Apps widget fetches and bridge resource/prompt calls
                    must take the hosted API branch on every platform. */}
                <WebManagedServersProvider value={true}>
                  <div
                    className="scenario-host-shell flex h-svh min-h-0 flex-col overflow-hidden"
                    data-host-style={hostStyle}
                    style={shellStyle}
                  >
                    <header className="border-b border-border/50 bg-background/95 backdrop-blur">
                      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
                        {/* Name the client, not the scenario. A tester arrives
                            here to try something in "Cursor" or "ChatGPT";
                            the scenario's internal name is the author's
                            label for it and means nothing to them. */}
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          {sessionForCurrentLink ? (
                            <>
                              <img
                                src={clientLogoSrc}
                                alt=""
                                className="size-5 shrink-0 object-contain"
                              />
                              <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">
                                {clientLabel}
                              </h1>
                            </>
                          ) : (
                            <>
                              {/* The skeleton is decorative, so the header
                                  would have no heading at all while the
                                  redeem is in flight. Name the shell for a
                                  screen reader without naming a vendor. */}
                              <h1 className="sr-only">Loading scenario</h1>
                              {/* Placeholder rather than the default host's
                                  mark: painting one brand and swapping to
                                  another once the redeem lands reads as a
                                  glitch. */}
                              <div
                                aria-hidden
                                className="h-5 w-28 animate-pulse rounded bg-muted"
                              />
                            </>
                          )}
                        </div>
                        <button
                          onClick={handleOpenMcpJam}
                          className="cursor-pointer flex-shrink-0 border-none bg-transparent p-0"
                        >
                          <img
                            src={
                              themeMode === "dark"
                                ? "/mcp_jam_dark.png"
                                : "/mcp_jam_light.png"
                            }
                            alt="MCPJam"
                            className="h-4 w-auto object-contain"
                          />
                        </button>
                        <div className="flex flex-1 items-center justify-end gap-1.5">
                          {session && shareableToken ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground"
                              onClick={handleCopyLink}
                            >
                              Copy link
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </header>

                    {renderContent()}
                  </div>
                </WebManagedServersProvider>
              </ScenarioSurfaceProvider>
            </ActiveHostCapsResolverScope>
          </ActiveMcpProfileProvider>
        </ScenarioHostCapabilitiesOverrideProvider>
      </ScenarioChatUiOverrideProvider>
    </ScenarioHostStyleProvider>
  );
}

export function getScenarioPathTokenFromLocation(): string | null {
  return extractScenarioTokenFromPath(window.location.pathname);
}
