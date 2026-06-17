import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import type { HttpServerConfig } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { XaaResourceApp } from "@/lib/xaa/types";
import type { NegativeTestMode } from "@/shared/xaa.js";
import { useProjectServers } from "./useProjects";

/**
 * The single mode-resolved input the XAA runner consumes. Mirrors the shape
 * the tab used to derive inline (XAAFlowTab.tsx). The confidential client
 * secret is never carried here — server-target runs resolve it server-side.
 */
export interface XAAFlowInput {
  mode: "hosted-registration" | "local-profile";
  registrationId?: string;
  serverUrl: string;
  authzServerIssuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  userId: string;
  email: string;
  negativeTestMode: NegativeTestMode;
}

export type XaaTargetSource = "registration" | "bar_server" | "none";

export interface XaaTestTarget {
  targetSource: XaaTargetSource;
  runInput: XAAFlowInput;
  /** Stable identity for the positive-run gate + reset effect. Distinct per
   * server/registration so a green run on one can't unlock another. */
  targetKey: string;
  /** RemoteServer id — only for a confidential bar_server run. */
  serverId?: string;
  projectId?: string;
  /** bar_server with a stored secret → resolve it (and the token endpoint)
   * server-side; the browser only sends serverId. */
  usesServerSideSecret: boolean;
  /** false for STDIO / non-OAuth / blank-URL servers. */
  isTestable: boolean;
  notTestableReason?: string;
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
  /** A selected registered resource app — overrides the bar server. */
  selectedRegistration: XaaResourceApp | null;
  runSettings: {
    userId: string;
    email: string;
    negativeTestMode: NegativeTestMode;
  };
  /** Active Convex project id, for resolving the server's id + project. */
  projectId: string | null;
}

/**
 * Resolve the active XAA target behind one seam so the tab doesn't inline the
 * precedence. A selected registration wins over the bar server. The runInput
 * is derived from the server's primitive fields (not the ServerWithName
 * object) to avoid churn.
 */
export function useXaaTestTarget({
  server,
  selectedServerName,
  selectedRegistration,
  runSettings,
  projectId,
}: UseXaaTestTargetParams): XaaTestTarget {
  const { isAuthenticated } = useConvexAuth();
  const { servers: remoteServers } = useProjectServers({
    projectId,
    isAuthenticated,
  });

  const httpConfig =
    server && "url" in server.config
      ? (server.config as HttpServerConfig)
      : null;
  const serverUrl = httpConfig?.url ? String(httpConfig.url) : "";
  const isHttp = Boolean(httpConfig);
  const useOAuth = server?.useOAuth === true;
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

    if (selectedRegistration) {
      return {
        targetSource: "registration",
        runInput: {
          mode: "hosted-registration",
          registrationId: selectedRegistration.id,
          serverUrl: selectedRegistration.resourceUrl,
          authzServerIssuer: selectedRegistration.issuer ?? "",
          clientId: selectedRegistration.targetClientId ?? "",
          clientSecret: "",
          scope: (selectedRegistration.scopes ?? []).join(" "),
          userId,
          email,
          negativeTestMode,
        },
        targetKey: `registration:${selectedRegistration.id}`,
        usesServerSideSecret: false,
        isTestable: true,
      };
    }

    const hasServer = selectedServerName !== "none" && Boolean(server);
    if (!hasServer) {
      return {
        targetSource: "none",
        runInput: emptyInput(userId, email, negativeTestMode),
        targetKey: "none",
        usesServerSideSecret: false,
        isTestable: false,
      };
    }

    const isTestable = isHttp && Boolean(serverUrl) && useOAuth;
    if (!isTestable) {
      return {
        targetSource: "bar_server",
        runInput: emptyInput(userId, email, negativeTestMode),
        targetKey: `bar_server:${selectedServerName}`,
        usesServerSideSecret: false,
        isTestable: false,
        notTestableReason: NOT_TESTABLE_REASON,
      };
    }

    const usesServerSideSecret = hasClientSecret && Boolean(remoteServerId);

    return {
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
        userId,
        email,
        negativeTestMode,
      },
      targetKey: `bar_server:${selectedServerName}`,
      serverId: remoteServerId,
      projectId: remoteProjectId ?? projectId ?? undefined,
      usesServerSideSecret,
      isTestable: true,
    };
  }, [
    selectedRegistration,
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
  ]);
}
