import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getStoredTokens, initiateOAuth } from "@/lib/oauth/mcp-oauth";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import {
  clearHostedOAuthPendingState,
  matchesHostedOAuthServerIdentity,
  writeHostedOAuthPendingMarker,
} from "@/lib/hosted-oauth-callback";
import {
  clearHostedOAuthResumeMarker,
  type HostedOAuthState,
  type HostedOAuthStatus,
  type HostedOAuthSurface,
  isHostedOAuthBusy,
  readHostedOAuthResumeMarker,
  sanitizeHostedOAuthErrorMessage,
} from "@/lib/hosted-oauth-resume";
import { validateHostedServer } from "@/lib/apis/web/servers-api";
import { slugify } from "@/lib/shared-server-session";

const INLINE_TOKEN_POLL_ATTEMPTS = 15;
const RESUME_TOKEN_POLL_ATTEMPTS = 24;
const TOKEN_POLL_MS = 250;
const VALIDATION_RETRY_ATTEMPTS = 3;
const VALIDATION_RETRY_MS = 400;

const TOKEN_MISSING_ERROR =
  "Authorization completed, but MCPJam could not find the access token. Try again.";
const VALIDATION_ERROR =
  "Authorization completed, but MCPJam could not verify access. Try again.";
const RUNTIME_OAUTH_ERROR =
  "Authorization expired or is missing. Authorize again to continue.";

export interface HostedOAuthServerDescriptor {
  serverId: string;
  serverName: string;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
  oauthScopes: string[] | null;
}

function buildHostedOAuthStateMap(
  oauthServers: HostedOAuthServerDescriptor[],
  surface: HostedOAuthSurface,
  previous: Record<string, HostedOAuthState> = {},
): Record<string, HostedOAuthState> {
  const resumeMarker = readHostedOAuthResumeMarker(surface);
  const nextState: Record<string, HostedOAuthState> = {};

  for (const server of oauthServers) {
    const existing = previous[server.serverId];
    const hasToken = !!getStoredTokens(server.serverName)?.access_token;
    const matchesResume =
      resumeMarker != null &&
      matchesHostedOAuthServerIdentity(
        {
          serverName: resumeMarker.serverName,
          serverUrl: resumeMarker.serverUrl,
        },
        {
          serverName: server.serverName,
          serverUrl: server.serverUrl,
        },
      );
    const serverUrl = server.serverUrl ?? existing?.serverUrl ?? null;

    let status: HostedOAuthStatus;
    let errorMessage: string | null = existing?.errorMessage ?? null;

    if (existing?.status === "launching") {
      status = "launching";
      errorMessage = null;
    } else if (matchesResume && resumeMarker?.errorMessage) {
      status = "error";
      errorMessage = resumeMarker.errorMessage;
    } else if (matchesResume) {
      status = hasToken ? "verifying" : "resuming";
      errorMessage = null;
    } else if (hasToken) {
      status = existing?.status === "ready" ? "ready" : "verifying";
      errorMessage = null;
    } else if (existing?.status === "error") {
      status = "error";
    } else {
      status = "needs_auth";
      errorMessage = null;
    }

    nextState[server.serverId] = {
      status,
      errorMessage,
      serverUrl,
    };
  }

  return nextState;
}

function setStoredOAuthTokenState(
  serverName: string,
  nextState: HostedOAuthState,
  setState: Dispatch<SetStateAction<Record<string, HostedOAuthState>>>,
  serverId: string,
) {
  setState((previous) => ({
    ...previous,
    [serverId]: {
      ...nextState,
      serverUrl: nextState.serverUrl ?? previous[serverId]?.serverUrl ?? null,
    },
  }));

  if (nextState.status === "needs_auth" || nextState.status === "error") {
    localStorage.removeItem(`mcp-tokens-${serverName}`);
  }
}

async function waitForStoredAccessToken(
  serverName: string,
  attempts: number,
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const accessToken = getStoredTokens(serverName)?.access_token;
    if (typeof accessToken === "string" && accessToken.trim()) {
      return accessToken;
    }

    await new Promise((resolve) => window.setTimeout(resolve, TOKEN_POLL_MS));
  }

  return null;
}

async function validateWithRetry(
  serverId: string,
  oauthAccessToken: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= VALIDATION_RETRY_ATTEMPTS; attempt++) {
    try {
      await validateHostedServer(serverId, oauthAccessToken);
      return { ok: true };
    } catch (error) {
      lastError = error;
      if (attempt < VALIDATION_RETRY_ATTEMPTS) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, VALIDATION_RETRY_MS),
        );
      }
    }
  }

  return { ok: false, error: lastError };
}

export interface UseHostedOAuthGateOptions {
  surface: HostedOAuthSurface;
  pendingKey: string;
  servers: HostedOAuthServerDescriptor[];
}

export interface UseHostedOAuthGateResult {
  oauthStateByServerId: Record<string, HostedOAuthState>;
  pendingOAuthServers: Array<{
    server: HostedOAuthServerDescriptor;
    state: HostedOAuthState;
  }>;
  hasBusyOAuth: boolean;
  authorizeServer: (server: HostedOAuthServerDescriptor) => Promise<void>;
  markOAuthRequired: (details?: HostedOAuthRequiredDetails) => void;
}

export function useHostedOAuthGate({
  surface,
  pendingKey,
  servers,
}: UseHostedOAuthGateOptions): UseHostedOAuthGateResult {
  const oauthServers = useMemo(
    () => servers.filter((server) => server.useOAuth),
    [servers],
  );
  const [oauthStateByServerId, setOAuthStateByServerId] = useState<
    Record<string, HostedOAuthState>
  >(() => buildHostedOAuthStateMap(oauthServers, surface));
  const oauthStateByServerIdRef = useRef(oauthStateByServerId);
  const processingServerIdsRef = useRef<Set<string>>(new Set());
  const isUnmountedRef = useRef(false);

  useEffect(() => {
    oauthStateByServerIdRef.current = oauthStateByServerId;
  }, [oauthStateByServerId]);

  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    setOAuthStateByServerId((previous) =>
      buildHostedOAuthStateMap(oauthServers, surface, previous),
    );
  }, [oauthServers, surface]);

  useEffect(() => {
    if (oauthServers.length === 0) {
      return;
    }

    const processServer = async (
      server: HostedOAuthServerDescriptor,
      status: HostedOAuthStatus,
    ) => {
      if (processingServerIdsRef.current.has(server.serverId)) {
        return;
      }

      processingServerIdsRef.current.add(server.serverId);
      try {
        const isResume = status === "resuming";
        const accessToken = isResume
          ? await waitForStoredAccessToken(
              server.serverName,
              RESUME_TOKEN_POLL_ATTEMPTS,
            )
          : (getStoredTokens(server.serverName)?.access_token ?? null);

        if (isUnmountedRef.current) return;

        if (!accessToken) {
          clearHostedOAuthResumeMarker();
          setStoredOAuthTokenState(
            server.serverName,
            {
              status: "error",
              errorMessage: TOKEN_MISSING_ERROR,
              serverUrl:
                oauthStateByServerIdRef.current[server.serverId]?.serverUrl ??
                server.serverUrl,
            },
            setOAuthStateByServerId,
            server.serverId,
          );
          return;
        }

        if (status !== "verifying") {
          setOAuthStateByServerId((previous) => ({
            ...previous,
            [server.serverId]: {
              status: "verifying",
              errorMessage: null,
              serverUrl:
                previous[server.serverId]?.serverUrl ??
                server.serverUrl ??
                null,
            },
          }));
        }

        const validation = await validateWithRetry(
          server.serverId,
          accessToken,
        );
        if (isUnmountedRef.current) return;

        if (validation.ok) {
          clearHostedOAuthResumeMarker();
          setOAuthStateByServerId((previous) => ({
            ...previous,
            [server.serverId]: {
              status: "ready",
              errorMessage: null,
              serverUrl:
                previous[server.serverId]?.serverUrl ??
                server.serverUrl ??
                null,
            },
          }));
          return;
        }

        console.error("[useHostedOAuthGate] OAuth validation failed", {
          surface,
          serverId: server.serverId,
          serverName: server.serverName,
          error: validation.error,
        });
        clearHostedOAuthResumeMarker();
        setStoredOAuthTokenState(
          server.serverName,
          {
            status: "error",
            errorMessage: sanitizeHostedOAuthErrorMessage(
              validation.error,
              VALIDATION_ERROR,
            ),
            serverUrl:
              oauthStateByServerIdRef.current[server.serverId]?.serverUrl ??
              server.serverUrl,
          },
          setOAuthStateByServerId,
          server.serverId,
        );
      } finally {
        processingServerIdsRef.current.delete(server.serverId);
      }
    };

    for (const server of oauthServers) {
      const currentStatus = oauthStateByServerId[server.serverId]?.status;
      if (currentStatus === "resuming" || currentStatus === "verifying") {
        void processServer(server, currentStatus);
      }
    }
  }, [oauthServers, oauthStateByServerId, surface]);

  const authorizeServer = useCallback(
    async (server: HostedOAuthServerDescriptor) => {
      clearHostedOAuthResumeMarker();
      clearHostedOAuthPendingState();
      setOAuthStateByServerId((previous) => ({
        ...previous,
        [server.serverId]: {
          status: "launching",
          errorMessage: null,
          serverUrl:
            previous[server.serverId]?.serverUrl ?? server.serverUrl ?? null,
        },
      }));

      if (!server.serverUrl) {
        setOAuthStateByServerId((previous) => ({
          ...previous,
          [server.serverId]: {
            status: "error",
            errorMessage:
              "This server is missing its OAuth URL. Try again or contact the owner.",
            serverUrl: previous[server.serverId]?.serverUrl ?? null,
          },
        }));
        return;
      }

      const returnHash =
        window.location.hash || `#${slugify(server.serverName)}`;
      writeHostedOAuthPendingMarker({
        surface,
        serverName: server.serverName,
        serverUrl: server.serverUrl,
        returnHash,
      });
      localStorage.setItem(pendingKey, "true");
      localStorage.setItem("mcp-oauth-return-hash", returnHash);

      const result = await initiateOAuth({
        serverName: server.serverName,
        serverUrl: server.serverUrl,
        clientId: server.clientId ?? undefined,
        scopes: server.oauthScopes ?? undefined,
      });

      if (!result.success) {
        clearHostedOAuthPendingState();
        localStorage.removeItem("mcp-oauth-pending");
        localStorage.removeItem("mcp-oauth-return-hash");
        localStorage.removeItem(pendingKey);
        setOAuthStateByServerId((previous) => ({
          ...previous,
          [server.serverId]: {
            status: "error",
            errorMessage: sanitizeHostedOAuthErrorMessage(
              result.error,
              "Authorization could not be started. Try again.",
            ),
            serverUrl:
              previous[server.serverId]?.serverUrl ?? server.serverUrl ?? null,
          },
        }));
        return;
      }

      const accessToken = await waitForStoredAccessToken(
        server.serverName,
        INLINE_TOKEN_POLL_ATTEMPTS,
      );

      if (accessToken) {
        clearHostedOAuthPendingState();
        localStorage.removeItem("mcp-oauth-pending");
        localStorage.removeItem("mcp-oauth-return-hash");
        localStorage.removeItem(pendingKey);
      }

      setOAuthStateByServerId((previous) => ({
        ...previous,
        [server.serverId]: {
          status: accessToken ? "verifying" : "resuming",
          errorMessage: null,
          serverUrl:
            previous[server.serverId]?.serverUrl ?? server.serverUrl ?? null,
        },
      }));
    },
    [pendingKey, surface],
  );

  const markOAuthRequired = useCallback(
    (details?: HostedOAuthRequiredDetails) => {
      setOAuthStateByServerId((previous) => {
        const nextState = { ...previous };
        const matchingServers = oauthServers.filter((server) => {
          if (details?.serverId && server.serverId === details.serverId) {
            return true;
          }
          if (details?.serverName && server.serverName === details.serverName) {
            return true;
          }
          if (details?.serverUrl && server.serverUrl === details.serverUrl) {
            return true;
          }
          return false;
        });

        const fallbackServer =
          matchingServers.length > 0
            ? null
            : oauthServers.length === 1
              ? oauthServers[0]
              : null;
        const targetServers =
          matchingServers.length > 0
            ? matchingServers
            : fallbackServer
              ? [fallbackServer]
              : oauthServers;

        for (const server of targetServers) {
          localStorage.removeItem(`mcp-tokens-${server.serverName}`);
          nextState[server.serverId] = {
            status: "needs_auth",
            errorMessage: details?.serverUrl ? null : RUNTIME_OAUTH_ERROR,
            serverUrl:
              details?.serverUrl ??
              previous[server.serverId]?.serverUrl ??
              server.serverUrl ??
              null,
          };
        }

        return nextState;
      });
    },
    [oauthServers],
  );

  const pendingOAuthServers = useMemo(
    () =>
      oauthServers
        .map((server) => ({
          server,
          state:
            oauthStateByServerId[server.serverId] ??
            ({
              status: "needs_auth",
              errorMessage: null,
              serverUrl: server.serverUrl,
            } satisfies HostedOAuthState),
        }))
        .filter(({ state }) => state.status !== "ready"),
    [oauthServers, oauthStateByServerId],
  );

  const hasBusyOAuth = pendingOAuthServers.some(({ state }) =>
    isHostedOAuthBusy(state.status),
  );

  return {
    oauthStateByServerId,
    pendingOAuthServers,
    hasBusyOAuth,
    authorizeServer,
    markOAuthRequired,
  };
}
