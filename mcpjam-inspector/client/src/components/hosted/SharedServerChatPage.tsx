import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useConvexAuth } from "convex/react";
import { ConvexError } from "convex/values";
import { useAuth } from "@workos-inc/authkit-react";
import { Loader2, Link2Off, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChatTabV2 } from "@/components/ChatTabV2";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useHostedApiContext } from "@/hooks/hosted/use-hosted-api-context";
import { useHostedOAuthGate } from "@/hooks/hosted/use-hosted-oauth-gate";
import { checkHostedServerOAuthRequirement } from "@/lib/apis/web/servers-api";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import {
  clearSharedServerSession,
  extractSharedTokenFromPath,
  getShareableAppOrigin,
  readSharedServerSession,
  slugify,
  SHARED_OAUTH_PENDING_KEY,
  type SharedServerSession,
  writeSharedServerSession,
  writePendingServerAdd,
} from "@/lib/shared-server-session";
import { getStoredTokens } from "@/lib/oauth/mcp-oauth";

function extractShareErrorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    return typeof error.data === "string"
      ? error.data
      : "This shared link is invalid or expired.";
  }
  if (error instanceof Error) {
    const uncaughtMatch = error.message.match(
      /Uncaught Error:\s*(.*?)\s*(?:\bat handler\b|$)/s,
    );
    if (uncaughtMatch) return uncaughtMatch[1].trim();
  }
  return "This shared link is invalid or expired.";
}

interface SharedServerChatPageProps {
  pathToken?: string | null;
  onExitSharedChat?: () => void;
}

function getSharedOAuthCopy(
  status: string,
  serverName: string,
): {
  title: string;
  description: string;
  buttonLabel: string | null;
} {
  switch (status) {
    case "launching":
      return {
        title: "Finishing authorization",
        description: "Opening the consent screen…",
        buttonLabel: null,
      };
    case "resuming":
      return {
        title: "Finishing authorization",
        description: "Waiting for the OAuth callback to finish…",
        buttonLabel: null,
      };
    case "verifying":
      return {
        title: "Finishing authorization",
        description: "Verifying access…",
        buttonLabel: null,
      };
    case "error":
      return {
        title: "Authorization Required",
        description:
          "Authorization could not be completed. Try again to continue.",
        buttonLabel: "Authorize again",
      };
    case "needs_auth":
    default:
      return {
        title: "Authorization Required",
        description: `${serverName} requires authorization to continue. You'll return here automatically after consent.`,
        buttonLabel: "Authorize",
      };
  }
}

export function SharedServerChatPage({
  pathToken,
  onExitSharedChat,
}: SharedServerChatPageProps) {
  const { getAccessToken } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const resolveShareForViewer = useMutation(
    "serverShares:resolveShareForViewer" as any,
  );

  const [session, setSession] = useState<SharedServerSession | null>(() =>
    readSharedServerSession(),
  );
  const [isResolving, setIsResolving] = useState(!!pathToken);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCheckingOAuthRequirement, setIsCheckingOAuthRequirement] = useState(
    () => !!session && !session.payload.useOAuth,
  );
  const [pendingRuntimeOAuthDetails, setPendingRuntimeOAuthDetails] =
    useState<HostedOAuthRequiredDetails | null>(null);

  const selectedServerName = session?.payload.serverName;
  const hostedServerIdsByName = useMemo(() => {
    if (!session) return {};
    const { serverId, serverName } = session.payload;
    return {
      [serverName]: serverId,
      [serverId]: serverId,
    };
  }, [session]);

  const oauthServers = useMemo(() => {
    if (!session) return [];
    return [
      {
        serverId: session.payload.serverId,
        serverName: session.payload.serverName,
        useOAuth: session.payload.useOAuth,
        serverUrl: session.payload.serverUrl,
        clientId: session.payload.clientId,
        oauthScopes: session.payload.oauthScopes,
      },
    ];
  }, [session]);

  const {
    oauthStateByServerId,
    pendingOAuthServers,
    authorizeServer,
    markOAuthRequired,
  } = useHostedOAuthGate({
    surface: "shared",
    pendingKey: SHARED_OAUTH_PENDING_KEY,
    servers: oauthServers,
  });

  const oauthTokensForChat = useMemo(() => {
    if (!session) return undefined;
    const { serverName, serverId } = session.payload;
    const tokens = getStoredTokens(serverName);
    if (!tokens?.access_token) return undefined;
    return { [serverId]: tokens.access_token };
  }, [session, oauthStateByServerId]);

  useHostedApiContext({
    workspaceId: session?.payload.workspaceId ?? null,
    serverIdsByName: hostedServerIdsByName,
    getAccessToken,
    oauthTokensByServerId: oauthTokensForChat,
    shareToken: session?.token,
    isAuthenticated,
  });

  const sharedServerConfigs = useMemo(() => {
    if (!session || !selectedServerName) return {};

    const server: ServerWithName = {
      name: selectedServerName,
      config: {
        url: "https://shared-chat.invalid",
      } as any,
      lastConnectionTime: new Date(),
      connectionStatus: "connected",
      retryCount: 0,
      enabled: true,
    };

    return {
      [selectedServerName]: server,
    } satisfies Record<string, ServerWithName>;
  }, [selectedServerName, session]);

  useEffect(() => {
    if (isAuthLoading || !isAuthenticated) {
      return;
    }

    let cancelled = false;

    const resolve = async () => {
      const tokenFromPath = pathToken?.trim() || null;

      if (tokenFromPath) {
        setIsResolving(true);
        setErrorMessage(null);
        try {
          const payload = await resolveShareForViewer({ token: tokenFromPath });
          if (cancelled) return;

          const nextSession: SharedServerSession = {
            token: tokenFromPath,
            payload,
          };
          writeSharedServerSession(nextSession);
          setSession(nextSession);

          const nextSlug = slugify(nextSession.payload.serverName);
          if (window.location.hash !== `#${nextSlug}`) {
            window.history.replaceState({}, "", `/#${nextSlug}`);
          }
        } catch (error) {
          if (cancelled) return;
          setSession(null);
          clearSharedServerSession();
          setErrorMessage(extractShareErrorMessage(error));
        } finally {
          if (!cancelled) {
            setIsResolving(false);
          }
        }
        return;
      }

      const recovered = readSharedServerSession();
      if (recovered) {
        setSession(recovered);
        setErrorMessage(null);
        const recoveredSlug = slugify(recovered.payload.serverName);
        if (window.location.hash !== `#${recoveredSlug}`) {
          window.history.replaceState({}, "", `/#${recoveredSlug}`);
        }
        return;
      }

      setSession(null);
      setErrorMessage("Invalid or expired share link");
    };

    void resolve();

    return () => {
      cancelled = true;
    };
  }, [isAuthLoading, isAuthenticated, pathToken, resolveShareForViewer]);

  useEffect(() => {
    if (!session) return;

    const expectedHash = slugify(session.payload.serverName);
    const enforceSharedHash = () => {
      if (window.location.hash !== `#${expectedHash}`) {
        window.location.hash = expectedHash;
      }
    };

    enforceSharedHash();
    window.addEventListener("hashchange", enforceSharedHash);
    return () => {
      window.removeEventListener("hashchange", enforceSharedHash);
    };
  }, [session]);

  useEffect(() => {
    if (!session || isAuthLoading || !isAuthenticated) return;

    if (session.payload.useOAuth) {
      setIsCheckingOAuthRequirement(false);
      return;
    }

    let cancelled = false;
    setIsCheckingOAuthRequirement(true);

    const discoverOAuthRequirement = async () => {
      try {
        const result = await checkHostedServerOAuthRequirement(
          session.payload.serverId,
        );
        if (cancelled || !result.useOAuth) {
          return;
        }

        const nextSession: SharedServerSession = {
          ...session,
          payload: {
            ...session.payload,
            useOAuth: true,
            serverUrl: result.serverUrl ?? session.payload.serverUrl,
          },
        };
        writeSharedServerSession(nextSession);
        setSession(nextSession);
      } catch (error) {
        if (!cancelled) {
          console.error(
            "[SharedServerChatPage] OAuth requirement check failed",
            {
              workspaceId: session.payload.workspaceId,
              serverId: session.payload.serverId,
              error,
            },
          );
        }
      } finally {
        if (!cancelled) {
          setIsCheckingOAuthRequirement(false);
        }
      }
    };

    void discoverOAuthRequirement();

    return () => {
      cancelled = true;
    };
  }, [isAuthLoading, isAuthenticated, session]);

  useEffect(() => {
    if (!pendingRuntimeOAuthDetails || !session?.payload.useOAuth) {
      return;
    }

    markOAuthRequired({
      serverId: pendingRuntimeOAuthDetails.serverId ?? session.payload.serverId,
      serverName:
        pendingRuntimeOAuthDetails.serverName ?? session.payload.serverName,
      serverUrl:
        pendingRuntimeOAuthDetails.serverUrl ?? session.payload.serverUrl,
    });
    setPendingRuntimeOAuthDetails(null);
  }, [markOAuthRequired, pendingRuntimeOAuthDetails, session]);

  const handleOAuthRequired = useCallback(
    (details?: HostedOAuthRequiredDetails) => {
      if (!session) {
        return;
      }

      const nextDetails: HostedOAuthRequiredDetails = {
        serverId: details?.serverId ?? session.payload.serverId,
        serverName: details?.serverName ?? session.payload.serverName,
        serverUrl: details?.serverUrl ?? session.payload.serverUrl,
      };

      setSession((previous) => {
        if (!previous) return previous;
        const nextSession: SharedServerSession = {
          ...previous,
          payload: {
            ...previous.payload,
            useOAuth: true,
            serverUrl: nextDetails.serverUrl ?? previous.payload.serverUrl,
          },
        };
        writeSharedServerSession(nextSession);
        return nextSession;
      });

      if (session.payload.useOAuth) {
        markOAuthRequired(nextDetails);
      } else {
        setPendingRuntimeOAuthDetails(nextDetails);
      }
    },
    [markOAuthRequired, session],
  );

  const handleOpenMcpJam = () => {
    if (session) {
      const effectiveServerUrl =
        session.payload.serverUrl ??
        oauthStateByServerId[session.payload.serverId]?.serverUrl;
      if (effectiveServerUrl) {
        writePendingServerAdd({
          serverName: session.payload.serverName,
          serverUrl: effectiveServerUrl,
          useOAuth: session.payload.useOAuth,
          clientId: session.payload.clientId,
          oauthScopes: session.payload.oauthScopes,
        });
      }
    }
    clearSharedServerSession();
    window.history.replaceState({}, "", "/#servers");
    onExitSharedChat?.();
  };

  const handleCopyLink = async () => {
    const token = session?.token?.trim();
    if (!session || !token) {
      toast.error("Share link unavailable");
      return;
    }

    if (!navigator.clipboard?.writeText) {
      toast.error("Copy is not available in this browser");
      return;
    }

    const shareUrl = `${getShareableAppOrigin()}/shared/${slugify(session.payload.serverName)}/${encodeURIComponent(token)}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied");
    } catch {
      toast.error("Failed to copy share link");
    }
  };

  const displayServerName = session?.payload.serverName || "\u00A0";
  const activeOAuthServer = pendingOAuthServers[0] ?? null;
  const activeOAuthState = activeOAuthServer?.state ?? null;
  const activeOAuthCopy = activeOAuthState
    ? getSharedOAuthCopy(activeOAuthState.status, displayServerName)
    : null;

  const renderContent = () => {
    if (isResolving || isCheckingOAuthRequirement) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (!session || !selectedServerName) {
      const isAccessDenied = errorMessage?.includes("don't have access");
      return (
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
            <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              {isAccessDenied ? (
                <ShieldX className="h-5 w-5 text-muted-foreground" />
              ) : (
                <Link2Off className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
            <h2 className="text-base font-semibold text-foreground">
              {isAccessDenied ? "Access Denied" : "Shared Link Unavailable"}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {errorMessage || "This shared link is invalid or expired."}
            </p>
            <Button className="mt-4" onClick={handleOpenMcpJam}>
              Open in App
            </Button>
          </div>
        </div>
      );
    }

    if (activeOAuthServer && activeOAuthState && activeOAuthCopy) {
      return (
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
            <h2 className="text-base font-semibold text-foreground">
              {activeOAuthCopy.title}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {activeOAuthState.status === "error" &&
              activeOAuthState.errorMessage
                ? activeOAuthState.errorMessage
                : activeOAuthCopy.description}
            </p>
            {activeOAuthCopy.buttonLabel ? (
              <Button
                className="mt-4"
                onClick={() => void authorizeServer(activeOAuthServer.server)}
              >
                {activeOAuthCopy.buttonLabel}
              </Button>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-0 flex-1">
        <ChatTabV2
          connectedOrConnectingServerConfigs={sharedServerConfigs}
          selectedServerNames={[selectedServerName]}
          minimalMode
          hostedWorkspaceIdOverride={session.payload.workspaceId}
          hostedSelectedServerIdsOverride={[session.payload.serverId]}
          hostedOAuthTokensOverride={oauthTokensForChat}
          hostedShareToken={session.token}
          onOAuthRequired={handleOAuthRequired}
        />
      </div>
    );
  };

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="border-b border-border/50 bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-2.5">
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {displayServerName}
          </h1>
          <button
            onClick={handleOpenMcpJam}
            className="cursor-pointer flex-shrink-0 border-none bg-transparent p-0"
          >
            <img
              src="/mcp_jam_dark.png"
              alt="MCPJam"
              className="hidden h-4 w-auto dark:block"
            />
            <img
              src="/mcp_jam_light.png"
              alt="MCPJam"
              className="block h-4 w-auto dark:hidden"
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
  );
}

export function getSharedPathTokenFromLocation(): string | null {
  return extractSharedTokenFromPath(window.location.pathname);
}
