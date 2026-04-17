import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Loader2, Link2Off, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { ChatTabV2 } from "@/components/ChatTabV2";
import { getLoadingIndicatorVariantForHostStyle } from "@/components/chat-v2/shared/loading-indicator-content";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useHostedApiContext } from "@/hooks/hosted/use-hosted-api-context";
import { useHostedOAuthGate } from "@/hooks/hosted/use-hosted-oauth-gate";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { getGuestBearerToken } from "@/lib/guest-session";
import { getStoredTokens } from "@/lib/oauth/mcp-oauth";
import {
  buildSandboxLink,
  clearSandboxSession,
  extractSandboxTokenFromPath,
  readPlaygroundSession,
  readSandboxSurfaceFromUrl,
  readSandboxSession,
  SANDBOX_OAUTH_PENDING_KEY,
  sandboxEnabledOptionalStorageKey,
  type SandboxSession,
  writeSandboxSession,
  writeSandboxSignInReturnPath,
} from "@/lib/sandbox-session";
import { bootstrapServerToHostedOAuthDescriptor } from "@/components/sandboxes/builder/sandbox-server-optional";
import { isHostedOAuthBusy } from "@/lib/hosted-oauth-resume";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import { slugify } from "@/lib/shared-server-session";
import { SandboxHostStyleProvider } from "@/contexts/sandbox-host-style-context";
import { SandboxHostOnboardingOverlays } from "@/components/hosted/SandboxHostOnboardingOverlays";
import { useSandboxHostIntroGate } from "@/components/hosted/useSandboxHostIntroGate";
import { getSandboxShellStyle } from "@/lib/sandbox-host-style";

interface SandboxChatPageProps {
  pathToken?: string | null;
  onExitSandboxChat?: () => void;
}

interface SandboxRouteError {
  status: number;
  code?: string;
  message: string;
  rawMessage: string;
}

type SandboxErrorKind =
  | "access_denied"
  | "guest_blocked"
  | "invalid_link"
  | "playground_expired"
  | "unexpected";

interface SandboxDisplayError {
  kind: SandboxErrorKind;
  title: string;
  message: string;
}

const INVALID_SANDBOX_LINK_MESSAGE =
  "This sandbox link is invalid or expired. Ask the owner to share a new link if you still need access.";
const UNEXPECTED_SANDBOX_ERROR_MESSAGE =
  "We couldn't open this sandbox right now. Please try again or open MCPJam.";

async function getHostedBearerHeader(
  getAccessToken: () => Promise<string | undefined | null>,
): Promise<string | null> {
  try {
    const workOsToken = await getAccessToken();
    if (workOsToken) {
      return `Bearer ${workOsToken}`;
    }
  } catch {
    // Fall through to guest auth.
  }

  const guestToken = await getGuestBearerToken();
  return guestToken ? `Bearer ${guestToken}` : null;
}

function sanitizeSandboxRouteErrorMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const withoutWrapper = normalized.replace(/^Uncaught Error:\s*/i, "");
  return withoutWrapper
    .replace(/\s+at\s+(?:async\s+)?[A-Za-z0-9_$./<>-]+(?:\s+\(|$).*/s, "")
    .trim();
}

function createSandboxRouteError(
  status: number,
  message: string,
  code?: string,
): SandboxRouteError {
  const fallbackMessage = `Request failed with status ${status}`;
  const rawMessage = message.trim() || fallbackMessage;
  const sanitizedMessage = sanitizeSandboxRouteErrorMessage(rawMessage);

  return {
    status,
    code,
    rawMessage,
    message: sanitizedMessage || fallbackMessage,
  };
}

async function readRouteError(response: Response): Promise<SandboxRouteError> {
  const bodyText = await response.text();
  const trimmedBody = bodyText.trim();
  let code: string | undefined;
  let message = trimmedBody;

  try {
    const body = (trimmedBody ? JSON.parse(trimmedBody) : null) as {
      code?: string;
      message?: string;
      error?: string;
    } | null;

    code = typeof body?.code === "string" ? body.code : undefined;
    message =
      body?.message ||
      body?.error ||
      trimmedBody ||
      `Request failed with status ${response.status}`;
  } catch {
    message = trimmedBody || `Request failed with status ${response.status}`;
  }

  return createSandboxRouteError(response.status, message, code);
}

function isSandboxRouteError(error: unknown): error is SandboxRouteError {
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

function getSandboxDisplayError(
  error: SandboxRouteError | null,
): SandboxDisplayError {
  if (!error) {
    return {
      kind: "invalid_link",
      title: "Sandbox Link Unavailable",
      message: INVALID_SANDBOX_LINK_MESSAGE,
    };
  }

  const normalizedMessage = error.message.toLowerCase();
  const requiresSignIn = normalizedMessage.includes(
    "sign in to access this sandbox",
  );
  const isAccessDenied = normalizedMessage.includes("don't have access");
  const isGuestBlocked =
    normalizedMessage.includes("guests cannot access") ||
    normalizedMessage.includes("guest access");
  const isInvalidLink =
    error.status === 404 ||
    error.code === "NOT_FOUND" ||
    normalizedMessage.includes("invalid or has expired") ||
    normalizedMessage.includes("invalid or expired");
  const isPlaygroundExpired = normalizedMessage.includes(
    "playground session expired",
  );

  if (isPlaygroundExpired) {
    return {
      kind: "playground_expired",
      title: "Preview unavailable",
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
      title: "Sandbox Link Unavailable",
      message: INVALID_SANDBOX_LINK_MESSAGE,
    };
  }

  return {
    kind: "unexpected",
    title: "Sandbox Link Unavailable",
    message: UNEXPECTED_SANDBOX_ERROR_MESSAGE,
  };
}

export function SandboxChatPage({
  pathToken,
  onExitSandboxChat,
}: SandboxChatPageProps) {
  const { getAccessToken, signIn } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const themeMode = usePreferencesStore((s) => s.themeMode);

  const playgroundParams = useMemo(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const isPlayground = params.get("playground") === "1";
      const playgroundId = params.get("playgroundId");
      return isPlayground && playgroundId ? { playgroundId } : null;
    } catch {
      return null;
    }
  }, []);

  const readCurrentSession = useCallback(() => {
    return playgroundParams
      ? readPlaygroundSession(playgroundParams.playgroundId)
      : readSandboxSession();
  }, [playgroundParams]);

  const writeCurrentSession = useCallback(
    (nextSession: SandboxSession) => {
      if (playgroundParams) {
        return;
      }

      writeSandboxSession(nextSession);
    },
    [playgroundParams],
  );

  const clearCurrentSession = useCallback(() => {
    if (playgroundParams) {
      return;
    }

    clearSandboxSession();
  }, [playgroundParams]);

  const [session, setSession] = useState<SandboxSession | null>(() =>
    readCurrentSession(),
  );
  const [isResolving, setIsResolving] = useState(
    Boolean(pathToken || playgroundParams),
  );
  const [routeError, setRouteError] = useState<SandboxRouteError | null>(null);

  const sessionServersRequired = useMemo(
    () => session?.payload.servers.filter((s) => !s.optional) ?? [],
    [session],
  );

  const sessionServersOptional = useMemo(
    () => session?.payload.servers.filter((s) => s.optional) ?? [],
    [session],
  );

  const [enabledOptionalServerIds, setEnabledOptionalServerIds] = useState<
    string[]
  >([]);

  useEffect(() => {
    if (!session?.token) return;
    try {
      const raw = sessionStorage.getItem(
        sandboxEnabledOptionalStorageKey(session.token),
      );
      if (!raw) {
        setEnabledOptionalServerIds((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const optionalIdSet = new Set(
        session.payload.servers
          .filter((s) => s.optional)
          .map((s) => s.serverId),
      );
      const next = parsed.filter(
        (id): id is string => typeof id === "string" && optionalIdSet.has(id),
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
    // Intentionally only re-hydrate when the share token changes — not when
    // `payload.servers` gets a new array identity on each render.
  }, [session?.token]);

  useEffect(() => {
    if (!session?.token) return;
    try {
      const key = sandboxEnabledOptionalStorageKey(session.token);
      const serialized = JSON.stringify(enabledOptionalServerIds);
      if (sessionStorage.getItem(key) === serialized) return;
      sessionStorage.setItem(key, serialized);
    } catch {
      // ignore
    }
  }, [session?.token, enabledOptionalServerIds]);

  const sessionServersActive = useMemo(() => {
    if (!session) return [];
    const enabled = new Set(enabledOptionalServerIds);
    const optionalActive = session.payload.servers.filter(
      (s) => s.optional && enabled.has(s.serverId),
    );
    return [...sessionServersRequired, ...optionalActive];
  }, [session, sessionServersRequired, enabledOptionalServerIds]);

  const oauthServers = useMemo(
    () => sessionServersActive.map(bootstrapServerToHostedOAuthDescriptor),
    [sessionServersActive],
  );

  const handleEnableSandboxOptionalServer = useCallback((serverId: string) => {
    setEnabledOptionalServerIds((prev) =>
      prev.includes(serverId) ? prev : [...prev, serverId],
    );
  }, []);

  const sandboxOptionalInventory = useMemo(() => {
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
    oauthStateByServerId,
    pendingOAuthServers,
    authorizeServer,
    markOAuthRequired,
    hasBusyOAuth,
  } = useHostedOAuthGate({
    surface: "sandbox",
    pendingKey: SANDBOX_OAUTH_PENDING_KEY,
    servers: oauthServers,
    workspaceId: session?.payload.workspaceId ?? null,
    sandboxToken: session?.token,
    isAuthenticated,
  });

  const sandboxServerConfigs = useMemo(() => {
    if (!session) return {};

    return Object.fromEntries(
      sessionServersActive.map((server) => [
        server.serverName,
        {
          name: server.serverName,
          config: {
            url: "https://sandbox-chat.invalid",
          } as any,
          lastConnectionTime: new Date(),
          connectionStatus: "connected",
          retryCount: 0,
          enabled: true,
        } satisfies ServerWithName,
      ]),
    );
  }, [session, sessionServersActive]);

  const hostedServerIdsByName = useMemo(() => {
    if (!session) return {};

    return Object.fromEntries(
      sessionServersActive.flatMap((server) => [
        [server.serverName, server.serverId],
        [server.serverId, server.serverId],
      ]),
    );
  }, [session, sessionServersActive]);

  const oauthTokensForChat = useMemo(() => {
    if (!session) return undefined;

    const entries = sessionServersActive
      .map((server) => {
        const token = getStoredTokens(server.serverName)?.access_token;
        return token ? ([server.serverId, token] as const) : null;
      })
      .filter((entry): entry is readonly [string, string] =>
        Array.isArray(entry),
      );

    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }, [oauthStateByServerId, session, sessionServersActive]);

  useHostedApiContext({
    workspaceId: session?.payload.workspaceId ?? null,
    serverIdsByName: hostedServerIdsByName,
    getAccessToken,
    oauthTokensByServerId: oauthTokensForChat,
    sandboxToken: session?.token,
    isAuthenticated,
  });

  useEffect(() => {
    if (isAuthLoading) {
      return;
    }

    let cancelled = false;

    const resolve = async () => {
      if (playgroundParams) {
        const snapshot = readPlaygroundSession(playgroundParams.playgroundId);
        if (snapshot) {
          setSession({ ...snapshot, surface: "preview" });
          setRouteError(null);
        } else {
          setSession(null);
          setRouteError(
            createSandboxRouteError(
              410,
              "Playground session expired. Return to the builder to preview.",
            ),
          );
        }
        setIsResolving(false);
        return;
      }

      const tokenFromPath = pathToken?.trim() || null;

      if (tokenFromPath) {
        setIsResolving(true);
        setRouteError(null);
        try {
          const authorization = await getHostedBearerHeader(getAccessToken);
          if (!authorization) {
            throw new Error(
              "Unable to create a hosted session for this sandbox.",
            );
          }

          const response = await fetch("/api/web/sandboxes/bootstrap", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: authorization,
            },
            body: JSON.stringify({ token: tokenFromPath }),
          });

          if (!response.ok) {
            throw await readRouteError(response);
          }

          const payload = (await response.json()) as SandboxSession["payload"];
          if (cancelled) return;

          const nextSession: SandboxSession = {
            token: tokenFromPath,
            payload,
            surface: readSandboxSurfaceFromUrl(window.location.search),
          };
          writeCurrentSession(nextSession);
          setSession(nextSession);
          setRouteError(null);

          const nextSlug = slugify(nextSession.payload.name);
          if (window.location.hash !== `#${nextSlug}`) {
            window.history.replaceState({}, "", `/#${nextSlug}`);
          }
        } catch (error) {
          if (cancelled) return;
          setSession(null);
          clearCurrentSession();

          const nextError = isSandboxRouteError(error)
            ? error
            : createSandboxRouteError(
                500,
                error instanceof Error
                  ? error.message
                  : "Unable to open this sandbox.",
              );
          const displayError = getSandboxDisplayError(nextError);

          if (displayError.kind === "unexpected") {
            console.error("[SandboxChatPage] Failed to bootstrap sandbox", {
              status: nextError.status,
              code: nextError.code,
              message: nextError.message,
              rawMessage: nextError.rawMessage,
            });
          }

          setRouteError(nextError);
        } finally {
          if (!cancelled) {
            setIsResolving(false);
          }
        }
        return;
      }

      const recovered = readCurrentSession();
      if (recovered) {
        setSession(recovered);
        setRouteError(null);
        const recoveredSlug = slugify(recovered.payload.name);
        if (window.location.hash !== `#${recoveredSlug}`) {
          window.history.replaceState({}, "", `/#${recoveredSlug}`);
        }
        return;
      }

      setSession(null);
      setRouteError(
        createSandboxRouteError(404, "Invalid or expired sandbox link"),
      );
    };

    void resolve();

    return () => {
      cancelled = true;
    };
  }, [
    clearCurrentSession,
    getAccessToken,
    isAuthLoading,
    pathToken,
    playgroundParams,
    readCurrentSession,
    writeCurrentSession,
  ]);

  useEffect(() => {
    if (!session) return;

    const expectedHash = slugify(session.payload.name);
    const enforceHash = () => {
      if (window.location.hash !== `#${expectedHash}`) {
        window.location.hash = expectedHash;
      }
    };

    enforceHash();
    window.addEventListener("hashchange", enforceHash);
    return () => {
      window.removeEventListener("hashchange", enforceHash);
    };
  }, [session]);

  const handleCopyLink = useCallback(async () => {
    const token = session?.token?.trim();
    if (!session || !token) {
      toast.error("Sandbox link unavailable");
      return;
    }

    if (!navigator.clipboard?.writeText) {
      toast.error("Copy is not available in this browser");
      return;
    }

    try {
      await navigator.clipboard.writeText(
        buildSandboxLink(token, session.payload.name),
      );
      toast.success("Sandbox link copied");
    } catch {
      toast.error("Failed to copy sandbox link");
    }
  }, [session]);

  const handleOpenMcpJam = useCallback(() => {
    clearSandboxSession();
    window.history.replaceState({}, "", "/#sandboxes");
    onExitSandboxChat?.();
  }, [onExitSandboxChat]);

  const handleSignIn = useCallback(() => {
    writeSandboxSignInReturnPath(window.location.pathname);
    signIn();
  }, [signIn]);

  const handleOAuthRequired = useCallback(
    (details?: HostedOAuthRequiredDetails) => {
      markOAuthRequired(details);
    },
    [markOAuthRequired],
  );

  const hostStyle = session?.payload.hostStyle ?? "claude";
  const shellStyle = getSandboxShellStyle(hostStyle, themeMode);
  const displayError = getSandboxDisplayError(routeError);
  const oauthPending = pendingOAuthServers.length > 0;
  const introGate = useSandboxHostIntroGate({
    sandboxId: session?.payload.sandboxId ?? "",
    servers: sessionServersRequired,
    oauthPending,
    hasBusyOAuth,
    pendingOAuthServers,
  });
  const isFinishingOAuth =
    pendingOAuthServers.length > 0 &&
    pendingOAuthServers.every(({ state }) => isHostedOAuthBusy(state.status));

  const renderContent = () => {
    if (isResolving) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (!session) {
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
              {!isAuthenticated && (isAccessDenied || guestBlocked) ? (
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

    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <ChatTabV2
          connectedOrConnectingServerConfigs={sandboxServerConfigs}
          selectedServerNames={sessionServersActive.map(
            (server) => server.serverName,
          )}
          minimalMode
          reasoningDisplayMode="hidden"
          loadingIndicatorVariant={getLoadingIndicatorVariantForHostStyle(
            hostStyle,
          )}
          hostedWorkspaceIdOverride={session.payload.workspaceId}
          hostedSelectedServerIdsOverride={sessionServersActive.map(
            (server) => server.serverId,
          )}
          hostedOAuthTokensOverride={oauthTokensForChat}
          hostedSandboxToken={session.token}
          hostedSandboxSurface={session.surface ?? "share_link"}
          initialModelId={session.payload.modelId}
          initialSystemPrompt={session.payload.systemPrompt}
          initialTemperature={session.payload.temperature}
          initialRequireToolApproval={session.payload.requireToolApproval}
          onOAuthRequired={handleOAuthRequired}
          sandboxComposerBlocked={introGate.composerBlocked}
          sandboxComposerBlockedReason="Get started or authorize to send messages…"
          sandboxOptionalInventory={sandboxOptionalInventory}
          onEnableSandboxOptionalServer={handleEnableSandboxOptionalServer}
        />
        <SandboxHostOnboardingOverlays
          showWelcome={introGate.showWelcome}
          onGetStarted={introGate.dismissIntro}
          welcomeBody={
            (session.payload.welcomeDialog?.enabled ?? true)
              ? session.payload.welcomeDialog?.body
              : undefined
          }
          showAuthPanel={introGate.showAuthPanel}
          pendingOAuthServers={pendingOAuthServers}
          authorizeServer={authorizeServer}
          isFinishingOAuth={isFinishingOAuth}
        />
      </div>
    );
  };

  return (
    <SandboxHostStyleProvider value={hostStyle}>
      <div
        className="sandbox-host-shell flex h-svh min-h-0 flex-col overflow-hidden"
        data-host-style={hostStyle}
        style={shellStyle}
      >
        <header className="border-b border-border/50 bg-background/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-2.5">
            <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {session?.payload.name || "\u00A0"}
            </h1>
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
              {session ? (
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
    </SandboxHostStyleProvider>
  );
}

export function getSandboxPathTokenFromLocation(): string | null {
  return extractSandboxTokenFromPath(window.location.pathname);
}
