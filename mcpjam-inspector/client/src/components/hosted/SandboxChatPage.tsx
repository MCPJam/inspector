import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Loader2, Link2Off, Lock, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChatTabV2 } from "@/components/ChatTabV2";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useHostedApiContext } from "@/hooks/hosted/use-hosted-api-context";
import { getGuestBearerToken } from "@/lib/guest-session";
import { getStoredTokens, initiateOAuth } from "@/lib/oauth/mcp-oauth";
import {
  buildSandboxLink,
  clearSandboxSession,
  extractSandboxTokenFromPath,
  readSandboxSession,
  SANDBOX_OAUTH_PENDING_KEY,
  type SandboxBootstrapServer,
  type SandboxSession,
  writeSandboxSession,
  writeSandboxSignInReturnPath,
} from "@/lib/sandbox-session";
import { slugify } from "@/lib/shared-server-session";

interface SandboxChatPageProps {
  pathToken?: string | null;
  onExitSandboxChat?: () => void;
}

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

async function readRouteErrorMessage(response: Response): Promise<string> {
  const bodyText = await response.text();
  const trimmedBody = bodyText.trim();

  try {
    const body = (trimmedBody ? JSON.parse(trimmedBody) : null) as
      | { message?: string; error?: string }
      | null;
    return (
      body?.message ||
      body?.error ||
      trimmedBody ||
      `Request failed with status ${response.status}`
    );
  } catch {
    return trimmedBody || `Request failed with status ${response.status}`;
  }
}

export function SandboxChatPage({
  pathToken,
  onExitSandboxChat,
}: SandboxChatPageProps) {
  const { getAccessToken, signIn } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();

  const [session, setSession] = useState<SandboxSession | null>(() =>
    readSandboxSession(),
  );
  const [isResolving, setIsResolving] = useState(!!pathToken);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCheckingOAuth, setIsCheckingOAuth] = useState(false);
  const [oauthPreflightError, setOauthPreflightError] = useState<
    string | null
  >(null);
  const [oauthRequiredServerIds, setOauthRequiredServerIds] = useState<
    string[]
  >([]);
  const [oauthRefreshNonce, setOauthRefreshNonce] = useState(0);

  const sandboxServerConfigs = useMemo(() => {
    if (!session) return {};

    return Object.fromEntries(
      session.payload.servers.map((server) => [
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
  }, [session]);

  const hostedServerIdsByName = useMemo(() => {
    if (!session) return {};

    return Object.fromEntries(
      session.payload.servers.flatMap((server) => [
        [server.serverName, server.serverId],
        [server.serverId, server.serverId],
      ]),
    );
  }, [session]);

  const oauthTokensForChat = useMemo(() => {
    if (!session) return undefined;

    const entries = session.payload.servers
      .map((server) => {
        const token = getStoredTokens(server.serverName)?.access_token;
        return token ? ([server.serverId, token] as const) : null;
      })
      .filter(
        (entry): entry is readonly [string, string] => Array.isArray(entry),
      );

    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }, [oauthRefreshNonce, session]);

  const oauthRequiredServers = useMemo(() => {
    if (!session) return [];
    const requiredIds = new Set(oauthRequiredServerIds);
    return session.payload.servers.filter((server) =>
      requiredIds.has(server.serverId),
    );
  }, [oauthRequiredServerIds, session]);

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
      const tokenFromPath = pathToken?.trim() || null;

      if (tokenFromPath) {
        setIsResolving(true);
        setErrorMessage(null);
        try {
          const authorization = await getHostedBearerHeader(getAccessToken);
          if (!authorization) {
            throw new Error("Unable to create a hosted session for this sandbox.");
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
            throw new Error(await readRouteErrorMessage(response));
          }

          const payload = (await response.json()) as SandboxSession["payload"];
          if (cancelled) return;

          const nextSession: SandboxSession = {
            token: tokenFromPath,
            payload,
          };
          writeSandboxSession(nextSession);
          setSession(nextSession);

          const nextSlug = slugify(nextSession.payload.name);
          if (window.location.hash !== `#${nextSlug}`) {
            window.history.replaceState({}, "", `/#${nextSlug}`);
          }
        } catch (error) {
          if (cancelled) return;
          setSession(null);
          clearSandboxSession();
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "This sandbox link is invalid or expired.",
          );
        } finally {
          if (!cancelled) {
            setIsResolving(false);
          }
        }
        return;
      }

      const recovered = readSandboxSession();
      if (recovered) {
        setSession(recovered);
        setErrorMessage(null);
        const recoveredSlug = slugify(recovered.payload.name);
        if (window.location.hash !== `#${recoveredSlug}`) {
          window.history.replaceState({}, "", `/#${recoveredSlug}`);
        }
        return;
      }

      setSession(null);
      setErrorMessage("Invalid or expired sandbox link");
    };

    void resolve();

    return () => {
      cancelled = true;
    };
  }, [getAccessToken, isAuthLoading, pathToken]);

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

  useEffect(() => {
    if (!session || isAuthLoading) return;

    let cancelled = false;

    const checkOAuth = async () => {
      const oauthServers = session.payload.servers.filter(
        (server) => server.useOAuth,
      );
      if (oauthServers.length === 0) {
        setOauthRequiredServerIds([]);
        setOauthPreflightError(null);
        return;
      }

      setIsCheckingOAuth(true);
      setOauthPreflightError(null);

      try {
        const authorization = await getHostedBearerHeader(getAccessToken);
        if (!authorization) {
          throw new Error("Unable to authorize sandbox servers.");
        }

        const missingServerIds: string[] = [];
        for (const server of oauthServers) {
          const tokens = getStoredTokens(server.serverName);
          if (!tokens?.access_token) {
            missingServerIds.push(server.serverId);
            continue;
          }

          const response = await fetch("/api/web/servers/validate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: authorization,
            },
            body: JSON.stringify({
              workspaceId: session.payload.workspaceId,
              serverId: server.serverId,
              oauthAccessToken: tokens.access_token,
              accessScope: "chat_v2",
              sandboxToken: session.token,
            }),
          });

          if (cancelled) return;

          if (response.ok) {
            continue;
          }

          localStorage.removeItem(`mcp-tokens-${server.serverName}`);
          missingServerIds.push(server.serverId);
        }

        if (!cancelled) {
          setOauthRequiredServerIds(missingServerIds);
        }
      } catch (error) {
        if (!cancelled) {
          setOauthPreflightError(
            error instanceof Error
              ? error.message
              : "OAuth preflight request failed unexpectedly.",
          );
        }
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
  }, [getAccessToken, isAuthLoading, oauthRefreshNonce, session]);

  const handleAuthorize = useCallback(
    async (server: SandboxBootstrapServer) => {
      if (!server.serverUrl) {
        toast.error(`Sandbox server "${server.serverName}" is missing an OAuth URL.`);
        return;
      }

      localStorage.setItem(SANDBOX_OAUTH_PENDING_KEY, "true");
      localStorage.setItem("mcp-oauth-return-hash", `#${slugify(server.serverName)}`);

      const result = await initiateOAuth({
        serverName: server.serverName,
        serverUrl: server.serverUrl,
        clientId: server.clientId ?? undefined,
        scopes: server.oauthScopes ?? undefined,
      });

      if (!result.success) {
        return;
      }

      localStorage.removeItem(SANDBOX_OAUTH_PENDING_KEY);
      setOauthPreflightError(null);

      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        const tokens = getStoredTokens(server.serverName);
        if (tokens?.access_token) {
          setOauthRefreshNonce((value) => value + 1);
          return;
        }
      }
    },
    [],
  );

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

  const renderContent = () => {
    if (isResolving || isCheckingOAuth) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (!session) {
      const isAccessDenied = errorMessage?.includes("don't have access");
      const guestBlocked =
        errorMessage?.includes("Guests cannot access") ||
        errorMessage?.includes("guest access");

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
              {isAccessDenied || guestBlocked
                ? "Access Denied"
                : "Sandbox Link Unavailable"}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {errorMessage || "This sandbox link is invalid or expired."}
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

    if (oauthRequiredServers.length > 0) {
      return (
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-xl rounded-lg border border-border bg-card p-6">
            <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Lock className="h-5 w-5 text-muted-foreground" />
            </div>
            <h2 className="text-center text-base font-semibold text-foreground">
              Authorization Required
            </h2>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              Authorize the required sandbox servers to continue.
            </p>
            <div className="mt-5 space-y-3">
              {oauthRequiredServers.map((server) => (
                <div
                  key={server.serverId}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {server.serverName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      OAuth required
                    </p>
                  </div>
                  <Button size="sm" onClick={() => void handleAuthorize(server)}>
                    Authorize
                  </Button>
                </div>
              ))}
            </div>
            {oauthPreflightError ? (
              <p className="mt-4 text-xs text-amber-700">{oauthPreflightError}</p>
            ) : null}
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
            connectedOrConnectingServerConfigs={sandboxServerConfigs}
            selectedServerNames={session.payload.servers.map(
              (server) => server.serverName,
            )}
            minimalMode
            hostedWorkspaceIdOverride={session.payload.workspaceId}
            hostedSelectedServerIdsOverride={session.payload.servers.map(
              (server) => server.serverId,
            )}
            hostedOAuthTokensOverride={oauthTokensForChat}
            hostedSandboxToken={session.token}
            initialModelId={session.payload.modelId}
            initialSystemPrompt={session.payload.systemPrompt}
            initialTemperature={session.payload.temperature}
            initialRequireToolApproval={session.payload.requireToolApproval}
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
            {session?.payload.name || "\u00A0"}
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

export function getSandboxPathTokenFromLocation(): string | null {
  return extractSandboxTokenFromPath(window.location.pathname);
}
