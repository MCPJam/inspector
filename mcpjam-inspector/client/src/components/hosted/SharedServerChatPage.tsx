import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useConvexAuth } from "convex/react";
import { ConvexError } from "convex/values";
import { useAuth } from "@workos-inc/authkit-react";
import { Loader2, Link2Off, Lock, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChatTabV2 } from "@/components/ChatTabV2";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useHostedApiContext } from "@/hooks/hosted/use-hosted-api-context";
import {
  clearSharedServerSession,
  extractSharedTokenFromPath,
  readSharedServerSession,
  slugify,
  SHARED_OAUTH_PENDING_KEY,
  type SharedServerSession,
  writeSharedServerSession,
  writePendingServerAdd,
} from "@/lib/shared-server-session";
import { getStoredTokens, initiateOAuth } from "@/lib/oauth/mcp-oauth";

function extractShareErrorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    return typeof error.data === "string"
      ? error.data
      : "This shared link is invalid or expired.";
  }
  if (error instanceof Error) {
    // Legacy fallback: Convex wraps errors as "[CONVEX ...] Uncaught Error: <msg> ..."
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

const OAUTH_PREFLIGHT_TOKEN_RETRY_MS = 250;
const OAUTH_PREFLIGHT_REQUEST_RETRY_MS = 1000;
const OAUTH_PREFLIGHT_VALIDATE_TOKEN_ATTEMPTS = 8;

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
  const [needsOAuth, setNeedsOAuth] = useState(false);
  const [discoveredServerUrl, setDiscoveredServerUrl] = useState<string | null>(
    null,
  );
  const [isCheckingOAuth, setIsCheckingOAuth] = useState(() => {
    if (!session) return false;
    // Always start as true for OAuth servers — even if tokens exist locally,
    // we need to validate them before rendering the chat UI.
    if (session.payload.useOAuth) return true;
    return true;
  });
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

  // Preflight OAuth check: validate stored tokens before rendering the chat UI.
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

          // Tokens exist locally — validate them before rendering the chat UI.
          // Keep isCheckingOAuth=true (the spinner) until validation resolves
          // so ChatTabV2 doesn't mount and fire requests with an expired token.
          {
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
              // Can't validate without a bearer token — trust local tokens.
              setNeedsOAuth(false);
              return;
            }

            if (cancelled) return;

            // Re-read tokens in case they were cleared while waiting for bearer.
            const freshTokens = getStoredTokens(session.payload.serverName);
            if (!freshTokens?.access_token) {
              if (!cancelled) setNeedsOAuth(true);
              return;
            }

            try {
              const validateRes = await fetch("/api/web/servers/validate", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${bearerToken}`,
                },
                body: JSON.stringify({
                  workspaceId: session.payload.workspaceId,
                  serverId: session.payload.serverId,
                  oauthAccessToken: freshTokens.access_token,
                  accessScope: "chat_v2",
                  shareToken: session.token,
                }),
              });

              if (cancelled) return;

              if (validateRes.ok) {
                // Token is valid — allow the chat UI to render.
                setNeedsOAuth(false);
              } else {
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

                console.error(
                  "[SharedServerChatPage] Stored OAuth token validation failed",
                  {
                    status: validateRes.status,
                    statusText: validateRes.statusText,
                    body,
                  },
                );
                if (!cancelled) {
                  // Clear the expired/invalid tokens so the auto-close
                  // polling effect (which watches localStorage) doesn't
                  // immediately find the stale tokens and flip needsOAuth
                  // back to false.
                  localStorage.removeItem(
                    `mcp-tokens-${session.payload.serverName}`,
                  );
                  setNeedsOAuth(true);
                }
              }
            } catch {
              // Network/unexpected error — trust local tokens, don't show modal.
              if (!cancelled) {
                setNeedsOAuth(false);
              }
            }
          }

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
    localStorage.setItem("mcp-oauth-return-hash", "#" + slugify(serverName));

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
    if (session) {
      const effectiveServerUrl =
        session.payload.serverUrl || discoveredServerUrl;
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
    if (!token) {
      toast.error("Share link unavailable");
      return;
    }

    if (!navigator.clipboard?.writeText) {
      toast.error("Copy is not available in this browser");
      return;
    }

    const shareUrl = `${window.location.origin}/shared/${slugify(session.payload.serverName)}/${encodeURIComponent(token)}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied");
    } catch {
      toast.error("Failed to copy share link");
    }
  };

  const displayServerName = session?.payload.serverName || "\u00A0";

  const renderContent = () => {
    if (isResolving || isCheckingOAuth) {
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

    if (needsOAuth) {
      return (
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
            <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Lock className="h-5 w-5 text-muted-foreground" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              Authorization Required
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {selectedServerName} requires authorization to continue.
            </p>
            <Button className="mt-4" onClick={handleAuthorize}>
              Authorize
            </Button>
          </div>
        </div>
      );
    }

    return (
      <>
        {oauthPreflightError ? (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            OAuth preflight hit an issue. Runtime OAuth detection remains
            enabled.
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <ChatTabV2
            connectedOrConnectingServerConfigs={sharedServerConfigs}
            selectedServerNames={[selectedServerName!]}
            minimalMode
            hostedWorkspaceIdOverride={session!.payload.workspaceId}
            hostedSelectedServerIdsOverride={[session!.payload.serverId]}
            hostedOAuthTokensOverride={oauthTokensForChat}
            hostedShareToken={session!.token}
            onOAuthRequired={handleOAuthRequired}
          />
        </div>
      </>
    );
  };

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="border-b border-border/50 bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-2.5">
          <h1 className="truncate text-sm font-semibold text-foreground min-w-0 flex-1">
            {displayServerName}
          </h1>
          <button
            onClick={handleOpenMcpJam}
            className="cursor-pointer flex-shrink-0 bg-transparent border-none p-0"
          >
            <img
              src="/mcp_jam_dark.png"
              alt="MCPJam"
              className="hidden dark:block h-4 w-auto"
            />
            <img
              src="/mcp_jam_light.png"
              alt="MCPJam"
              className="block dark:hidden h-4 w-auto"
            />
          </button>
          <div className="flex items-center gap-1.5 flex-1 justify-end">
            {session && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={handleCopyLink}
              >
                Copy link
              </Button>
            )}
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
