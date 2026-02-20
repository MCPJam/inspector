import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Loader2, Link2Off, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChatTabV2 } from "@/components/ChatTabV2";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useHostedApiContext } from "@/hooks/hosted/use-hosted-api-context";
import {
  clearSharedServerSession,
  extractSharedTokenFromPath,
  isSharedChatHash,
  readSharedServerSession,
  SHARED_OAUTH_PENDING_KEY,
  type SharedServerSession,
  writeSharedServerSession,
} from "@/lib/shared-server-session";
import { getStoredTokens, initiateOAuth } from "@/lib/oauth/mcp-oauth";

interface SharedServerChatPageProps {
  pathToken?: string | null;
}

const SHARED_CHAT_HASH = "shared-chat";
const OAUTH_PREFLIGHT_TOKEN_RETRY_MS = 250;
const OAUTH_PREFLIGHT_REQUEST_RETRY_MS = 1000;
const OAUTH_PREFLIGHT_VALIDATE_TOKEN_ATTEMPTS = 8;

export function SharedServerChatPage({ pathToken }: SharedServerChatPageProps) {
  const { getAccessToken } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const resolveShareForViewer = useMutation(
    "serverShares:resolveShareForViewer" as any,
  );

  const [session, setSession] = useState<SharedServerSession | null>(() =>
    readSharedServerSession(),
  );
  const [isResolving, setIsResolving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [needsOAuth, setNeedsOAuth] = useState(false);
  const [discoveredServerUrl, setDiscoveredServerUrl] = useState<string | null>(null);
  const [isCheckingOAuth, setIsCheckingOAuth] = useState(false);
  const [oauthPreflightError, setOauthPreflightError] = useState<string | null>(
    null,
  );

  const selectedServerName = session?.payload.serverName;
  const hostedServerIdsByName = useMemo(() => {
    if (!session) return {};
    const { serverId, serverName } = session.payload;
    return {
      [serverName]: serverId,
      [serverId]: serverId,
    };
  }, [session]);

  // Build OAuth tokens map early so both useHostedApiContext and ChatTabV2 can use it.
  // The global hosted context needs it for widget-content and other direct API calls.
  const oauthTokensForChat = useMemo(() => {
    if (!session) return undefined;
    const { serverName, serverId } = session.payload;
    const tokens = getStoredTokens(serverName);
    if (!tokens?.access_token) return undefined;
    return { [serverId]: tokens.access_token };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, needsOAuth]);

  useHostedApiContext({
    workspaceId: session?.payload.workspaceId ?? null,
    serverIdsByName: hostedServerIdsByName,
    getAccessToken,
    oauthTokensByServerId: oauthTokensForChat,
    shareToken: session?.token,
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

          if (!isSharedChatHash(window.location.hash)) {
            window.history.replaceState({}, "", "/#shared-chat");
          }
        } catch (error) {
          if (cancelled) return;
          setSession(null);
          clearSharedServerSession();
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Invalid or expired share link",
          );
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
        if (!isSharedChatHash(window.location.hash)) {
          window.history.replaceState({}, "", "/#shared-chat");
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

    const enforceSharedHash = () => {
      if (!isSharedChatHash(window.location.hash)) {
        window.location.hash = SHARED_CHAT_HASH;
      }
    };

    enforceSharedHash();
    window.addEventListener("hashchange", enforceSharedHash);
    return () => {
      window.removeEventListener("hashchange", enforceSharedHash);
    };
  }, [session]);

  // Check if OAuth is required after session is resolved
  useEffect(() => {
    if (!session) return;
    const { useOAuth, serverName } = session.payload;
    const tokens = getStoredTokens(serverName);

    if (!useOAuth) {
      setNeedsOAuth(false);
      return;
    }

    if (tokens?.access_token) {
      setNeedsOAuth(false);
    } else {
      setNeedsOAuth(true);
    }
  }, [session]);

  // Preflight OAuth check: if Convex didn't set useOAuth, ask the server endpoint
  useEffect(() => {
    if (!session || isAuthLoading || !isAuthenticated) return;

    let cancelled = false;

    const checkOAuth = async () => {
      setIsCheckingOAuth(true);
      setOauthPreflightError(null);
      try {
        if (session.payload.useOAuth) {
          const tokens = getStoredTokens(session.payload.serverName);

          if (!tokens?.access_token) {
            setNeedsOAuth(true);
            return;
          }

          let bearerToken: string | null | undefined = null;
          for (
            let attempt = 1;
            attempt <= OAUTH_PREFLIGHT_VALIDATE_TOKEN_ATTEMPTS;
            attempt++
          ) {
            try {
              bearerToken = await getAccessToken();
            } catch {}

            if (cancelled) return;
            if (bearerToken) break;
            if (attempt < OAUTH_PREFLIGHT_VALIDATE_TOKEN_ATTEMPTS) {
              await new Promise((resolve) =>
                window.setTimeout(resolve, OAUTH_PREFLIGHT_TOKEN_RETRY_MS),
              );
            }
          }

          if (!bearerToken) {
            const message =
              "Could not validate stored OAuth token because WorkOS bearer token is unavailable. Trusting local OAuth token.";
            setOauthPreflightError(message);
            setNeedsOAuth(false);
            return;
          }

          const validateRes = await fetch("/api/web/servers/validate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${bearerToken}`,
            },
            body: JSON.stringify({
              workspaceId: session.payload.workspaceId,
              serverId: session.payload.serverId,
              oauthAccessToken: tokens.access_token,
              accessScope: "chat_v2",
              shareToken: session.token,
            }),
          });

          if (cancelled) return;

          if (!validateRes.ok) {
            let body: unknown = null;
            try {
              const textBody = await validateRes.text();
              if (textBody) {
                try {
                  body = JSON.parse(textBody);
                } catch {
                  body = textBody;
                }
              }
            } catch {
              body = "Unable to read validation error response body";
            }

            console.error("[SharedServerChatPage] Stored OAuth token validation failed", {
              status: validateRes.status,
              statusText: validateRes.statusText,
              body,
            });
            setNeedsOAuth(true);
            return;
          }

          setOauthPreflightError(null);
          setNeedsOAuth(false);
          return;
        }

        let warnedMissingToken = false;

        while (!cancelled) {
          let token: string | null | undefined = null;
          try {
            token = await getAccessToken();
          } catch (error) {
            if (cancelled) return;
            const message =
              "OAuth preflight could not retrieve a WorkOS bearer token yet. Retrying...";
            if (!warnedMissingToken) {
              console.error("[SharedServerChatPage] " + message, error);
              warnedMissingToken = true;
            }
            setOauthPreflightError(message);
            await new Promise((resolve) =>
              window.setTimeout(resolve, OAUTH_PREFLIGHT_TOKEN_RETRY_MS),
            );
            continue;
          }
          if (cancelled) return;

          if (!token) {
            const message =
              "OAuth preflight waiting for WorkOS bearer token. Retrying...";
            if (!warnedMissingToken) {
              console.warn("[SharedServerChatPage] " + message, {
                workspaceId: session.payload.workspaceId,
                serverId: session.payload.serverId,
              });
              warnedMissingToken = true;
            }
            setOauthPreflightError(message);
            await new Promise((resolve) =>
              window.setTimeout(resolve, OAUTH_PREFLIGHT_TOKEN_RETRY_MS),
            );
            continue;
          }

          const res = await fetch("/api/web/servers/check-oauth", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              workspaceId: session.payload.workspaceId,
              serverId: session.payload.serverId,
              accessScope: "chat_v2",
              shareToken: session.token,
            }),
          });

          if (cancelled) return;

          if (!res.ok) {
            let body: unknown = null;
            try {
              const textBody = await res.text();
              if (textBody) {
                try {
                  body = JSON.parse(textBody);
                } catch {
                  body = textBody;
                }
              }
            } catch {
              body = "Unable to read error response body";
            }
            if (cancelled) return;

            const message = `OAuth preflight failed: ${res.status} ${res.statusText}. Retrying...`;
            console.error("[SharedServerChatPage] " + message, {
              workspaceId: session.payload.workspaceId,
              serverId: session.payload.serverId,
              status: res.status,
              statusText: res.statusText,
              body,
            });
            setOauthPreflightError(message);
            await new Promise((resolve) =>
              window.setTimeout(resolve, OAUTH_PREFLIGHT_REQUEST_RETRY_MS),
            );
            continue;
          }

          const data = (await res.json()) as {
            useOAuth?: boolean;
            serverUrl?: string | null;
          };
          if (cancelled) return;

          setOauthPreflightError(null);

          if (data.useOAuth) {
            if (data.serverUrl) {
              setDiscoveredServerUrl(data.serverUrl);
            }

            const nextSession: SharedServerSession = {
              ...session,
              payload: {
                ...session.payload,
                useOAuth: true,
                serverUrl: data.serverUrl ?? session.payload.serverUrl,
              },
            };
            writeSharedServerSession(nextSession);
            setSession(nextSession);

            const tokens = getStoredTokens(session.payload.serverName);
            if (!tokens?.access_token) {
              setNeedsOAuth(true);
            }
          }

          return;
        }
      } catch (error) {
        if (cancelled) return;
        const message = "OAuth preflight request failed unexpectedly.";
        console.error("[SharedServerChatPage] " + message, error);
        setOauthPreflightError(message);
      } finally {
        if (!cancelled) {
          setIsCheckingOAuth(false);
        }
      }
    };

    void checkOAuth();

    return () => {
      cancelled = true;
    };
  }, [session, isAuthLoading, isAuthenticated, getAccessToken]);

  const handleOAuthRequired = useCallback((serverUrl?: string) => {
    if (serverUrl) {
      setDiscoveredServerUrl(serverUrl);
    }
    setNeedsOAuth(true);
  }, []);

  const handleAuthorize = async () => {
    if (!session) return;
    const { serverName, clientId, oauthScopes } = session.payload;
    const serverUrl = session.payload.serverUrl || discoveredServerUrl;
    if (!serverUrl) return;

    localStorage.setItem(SHARED_OAUTH_PENDING_KEY, "true");
    localStorage.setItem("mcp-oauth-return-hash", "#shared-chat");

    const result = await initiateOAuth({
      serverName,
      serverUrl,
      clientId: clientId ?? undefined,
      scopes: oauthScopes ?? undefined,
    });

    // If initiateOAuth returns without redirecting (already authorized)
    if (result.success) {
      localStorage.removeItem(SHARED_OAUTH_PENDING_KEY);
      setOauthPreflightError(null);
      const initialTokens = getStoredTokens(serverName);
      if (initialTokens?.access_token) {
        setNeedsOAuth(false);
        return;
      }

      // Token writes can lag briefly in some callback paths. Poll briefly.
      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        const polledTokens = getStoredTokens(serverName);
        if (polledTokens?.access_token) {
          setNeedsOAuth(false);
          return;
        }
      }
    }
  };

  // If modal is currently open, auto-close it as soon as a token appears.
  useEffect(() => {
    if (!needsOAuth || !session?.payload.useOAuth) return;

    const serverName = session.payload.serverName;
    const interval = window.setInterval(() => {
      const tokens = getStoredTokens(serverName);
      if (tokens?.access_token) {
        setOauthPreflightError(null);
        setNeedsOAuth(false);
      }
    }, 250);

    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
    }, 15_000);

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [needsOAuth, session]);

  const handleOpenMcpJam = () => {
    setSession(null);
    clearSharedServerSession();
    window.history.replaceState({}, "", "/#servers");
  };

  const handleCopyLink = async () => {
    const token = session?.token?.trim();
    if (!token) {
      toast.error("Share link unavailable");
      return;
    }

    if (!navigator.clipboard?.writeText) {
      toast.error("Copy is not available in this browser");
      return;
    }

    const shareUrl = `${window.location.origin}/shared/${encodeURIComponent(token)}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied");
    } catch {
      toast.error("Failed to copy share link");
    }
  };

  if (isResolving || isCheckingOAuth) {
    return (
      <div className="flex h-svh min-h-0 items-center justify-center px-4">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>
            {oauthPreflightError
              ? "Checking server authorization..."
              : "Opening shared server chat..."}
          </span>
        </div>
      </div>
    );
  }

  if (!session || !selectedServerName) {
    return (
      <div className="flex h-svh min-h-0 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Link2Off className="h-5 w-5 text-muted-foreground" />
          </div>
          <h2 className="text-base font-semibold text-foreground">
            Shared Link Unavailable
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {errorMessage || "This shared link is invalid or expired."}
          </p>
          <Button className="mt-4" onClick={handleOpenMcpJam}>
            Open MCPJam
          </Button>
        </div>
      </div>
    );
  }

  if (needsOAuth) {
    return (
      <div className="flex h-svh min-h-0 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <h2 className="text-base font-semibold text-foreground">
            Authorization Required
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This server requires OAuth authorization before you can chat. Click
            below to authorize access.
          </p>
          <Button className="mt-4" onClick={handleAuthorize}>
            Authorize
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="border-b border-border/50 bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-2.5">
          <h1 className="truncate text-sm font-semibold text-foreground">
            {session.payload.serverName}
          </h1>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={handleCopyLink}
            >
              Copy link
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={handleOpenMcpJam}
            >
              Open MCPJam
            </Button>
          </div>
        </div>
      </header>

      {oauthPreflightError ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          OAuth preflight hit an issue. Runtime OAuth detection remains enabled.
        </div>
      ) : null}

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
    </div>
  );
}

export function getSharedPathTokenFromLocation(): string | null {
  return extractSharedTokenFromPath(window.location.pathname);
}
