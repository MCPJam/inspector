import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import type { HttpServerConfig } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  resolveXaaTestIdentity,
  type XaaIdentityPair,
} from "@/lib/xaa/identity";
import type { NegativeTestMode } from "@/shared/xaa.js";
import { useProjectServers } from "./useProjects";

/**
 * The single mode-resolved input the XAA runner consumes. Mirrors the shape
 * the tab used to derive inline (XAAFlowTab.tsx). The confidential client
 * secret is never carried here — server-target runs resolve it server-side.
 */
export interface XAAFlowInput {
  mode: "local-profile";
  serverUrl: string;
  authzServerIssuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  userId: string;
  email: string;
  negativeTestMode: NegativeTestMode;
}

export type XaaTargetSource = "bar_server" | "none";

export interface XaaTestTarget {
  targetSource: XaaTargetSource;
  runInput: XAAFlowInput;
  /** Stable identity for the positive-run gate + reset effect. Distinct per
   * server so a green run on one can't unlock another. */
  targetKey: string;
  /** RemoteServer id — only for a confidential bar_server run. */
  serverId?: string;
  projectId?: string;
  /** Hosted identity of the selected server in the server bar, so editing
   * that bar server can reveal its saved secret. */
  barServerId?: string;
  barServerProjectId?: string;
  /** bar_server with a stored secret → resolve it (and the token endpoint)
   * server-side; the browser only sends serverId. A server with a secret is
   * ALWAYS confidential — it can never run as a public client with an empty
   * secret, even before its serverId resolves. */
  usesServerSideSecret: boolean;
  /** Confidential server whose secret can't be sent right now because its
   * RemoteServer id hasn't resolved (not synced to this project, or still
   * loading). Runs must be blocked in this state — sending an empty secret
   * would make the auth server reject the client. */
  secretUnavailable: boolean;
  /** The project-servers query is still loading; distinguishes a transient
   * "resolving" from a terminal "couldn't resolve". */
  serversLoading: boolean;
  /** false for STDIO / non-OAuth / blank-URL servers. */
  isTestable: boolean;
  notTestableReason?: string;
  /** Set when the identity could not be resolved atomically (a partial
   * legacy per-server override). The run must be blocked with this
   * actionable error — the same one Connect surfaces — rather than mixing
   * identity sources. */
  identityError?: string;
}

const NOT_TESTABLE_REASON =
  "This server can't be XAA-tested — it needs an HTTP URL and OAuth.";

function emptyInput(
  userId: string,
  email: string,
  negativeTestMode: NegativeTestMode,
): XAAFlowInput {
  return {
    mode: "local-profile",
    serverUrl: "",
    authzServerIssuer: "",
    clientId: "",
    clientSecret: "",
    scope: "",
    userId,
    email,
    negativeTestMode,
  };
}

interface UseXaaTestTargetParams {
  /** The currently selected bar server (from app state). */
  server?: ServerWithName;
  selectedServerName: string;
  runSettings: {
    userId: string;
    email: string;
    negativeTestMode: NegativeTestMode;
  };
  /** The selected "Run as" test identity, already resolved against the fetched
   * roster by the caller (null = no selection = today's behavior). A person is
   * ATOMIC: both subject and email are used together — never one person's
   * subject with a server's or the default's email. */
  selectedPerson: { _id: string; subject: string; email: string } | null;
  /** Active Convex project id, for resolving the server's id + project. */
  projectId: string | null;
  /** The active project's admin-controlled `xaaTestDefaults.defaultIdentity`
   * (atomic pair), threaded from the owning page. Sits between the
   * per-server override and the run-settings fallback in precedence. */
  projectDefault?: XaaIdentityPair | null;
}

/** Identity precedence (all ATOMIC pairs — never one source's subject with
 * another's email): person → complete per-server override → project default
 * → run-settings fallback. A PARTIAL server override resolves to an error
 * that must block the run (same actionable message as Connect). */
function resolveIdentityForRun(
  selectedPerson: { subject: string; email: string } | null,
  server: ServerWithName | undefined,
  projectDefault: XaaIdentityPair | null | undefined,
  fallbackUserId: string,
  fallbackEmail: string,
): { userId: string; email: string; identityError?: string } {
  const resolution = resolveXaaTestIdentity({
    selectedPerson,
    serverOverride: server
      ? { subject: server.xaaSubject, email: server.xaaEmail }
      : null,
    projectDefault,
    runFallback: { subject: fallbackUserId, email: fallbackEmail },
  });
  if (!resolution.ok) {
    // Keep the run input coherent (fallback identity) but carry the error —
    // the consumer must gate the run on it.
    return {
      userId: fallbackUserId,
      email: fallbackEmail,
      identityError: resolution.error,
    };
  }
  return {
    userId: resolution.identity.subject,
    email: resolution.identity.email,
  };
}

/**
 * Resolve the active XAA target behind one seam so the tab doesn't inline the
 * precedence. The runInput is derived from the server's primitive fields (not
 * the ServerWithName object) to avoid churn.
 */
export function useXaaTestTarget({
  server,
  selectedServerName,
  runSettings,
  selectedPerson,
  projectId,
  projectDefault = null,
}: UseXaaTestTargetParams): XaaTestTarget {
  const { isAuthenticated } = useConvexAuth();
  const { servers: remoteServers, isLoading: serversLoading } =
    useProjectServers({
      projectId,
      isAuthenticated,
    });

  const httpConfig =
    server && "url" in server.config
      ? (server.config as HttpServerConfig)
      : null;
  const serverUrl = httpConfig?.url ? String(httpConfig.url) : "";
  const isHttp = Boolean(httpConfig);
  // A server is XAA-testable if it uses OAuth (legacy XAA targets carry
  // useOAuth) OR it was configured with the Cross-App Access auth type on the
  // Connect page (useXaa, useOAuth left false).
  const useOAuth = server?.useOAuth === true;
  const useXaa = server?.useXaa === true;
  const clientId =
    server?.oauthFlowProfile?.clientId ??
    (typeof (httpConfig as any)?.clientId === "string"
      ? (httpConfig as any).clientId
      : "");
  const scope = (server?.oauthFlowProfile?.scopes ?? "")
    .replace(/,/g, " ")
    .trim();
  const xaaAuthzIssuer = server?.xaaAuthzIssuer ?? "";
  const hasClientSecret = server?.hasClientSecret === true;

  const remoteServer = useMemo(
    () => remoteServers?.find((s) => s.name === selectedServerName),
    [remoteServers, selectedServerName],
  );
  const remoteServerId = remoteServer?._id;
  const remoteProjectId = remoteServer?.projectId;

  return useMemo<XaaTestTarget>(() => {
    const { userId, email, negativeTestMode } = runSettings;
    const barServerContext = {
      barServerId: remoteServerId,
      barServerProjectId: remoteProjectId ?? projectId ?? undefined,
    };

    const hasServer = selectedServerName !== "none" && Boolean(server);
    if (!hasServer) {
      return {
        ...barServerContext,
        targetSource: "none",
        runInput: emptyInput(userId, email, negativeTestMode),
        targetKey: "none",
        usesServerSideSecret: false,
        secretUnavailable: false,
        serversLoading,
        isTestable: false,
      };
    }

    const isTestable = isHttp && Boolean(serverUrl) && (useOAuth || useXaa);
    if (!isTestable) {
      return {
        ...barServerContext,
        targetSource: "bar_server",
        runInput: emptyInput(userId, email, negativeTestMode),
        targetKey: `bar_server:${selectedServerName}`,
        usesServerSideSecret: false,
        secretUnavailable: false,
        serversLoading,
        isTestable: false,
        notTestableReason: NOT_TESTABLE_REASON,
      };
    }

    // A server with a stored secret is ALWAYS confidential — never fall back
    // to a public-client run with an empty secret (the auth server would
    // reject it). The secret is sent only via the serverId path; until that
    // id resolves, the run is blocked rather than silently sent without it.
    const usesServerSideSecret = hasClientSecret;
    const secretUnavailable = hasClientSecret && !remoteServerId;
    // A selected "Run as" person wins atomically; otherwise the complete
    // per-server override (synced with the /servers Connect page), then the
    // project default, then the global run-settings fallback. A PARTIAL
    // legacy override surfaces identityError and the run must be blocked.
    const identity = resolveIdentityForRun(
      selectedPerson,
      server,
      projectDefault,
      userId,
      email,
    );

    return {
      ...barServerContext,
      targetSource: "bar_server",
      runInput: {
        mode: "local-profile",
        serverUrl,
        authzServerIssuer: xaaAuthzIssuer,
        clientId,
        // The confidential secret is resolved server-side and never enters
        // the browser; public clients simply have none.
        clientSecret: "",
        scope,
        userId: identity.userId,
        email: identity.email,
        negativeTestMode,
      },
      targetKey: `bar_server:${selectedServerName}`,
      serverId: remoteServerId,
      projectId: remoteProjectId ?? projectId ?? undefined,
      usesServerSideSecret,
      secretUnavailable,
      serversLoading,
      isTestable: true,
      ...(identity.identityError
        ? { identityError: identity.identityError }
        : {}),
    };
  }, [
    serversLoading,
    server,
    selectedServerName,
    serverUrl,
    isHttp,
    useOAuth,
    clientId,
    scope,
    xaaAuthzIssuer,
    hasClientSecret,
    remoteServerId,
    remoteProjectId,
    projectId,
    runSettings,
    selectedPerson,
    projectDefault,
  ]);
}
