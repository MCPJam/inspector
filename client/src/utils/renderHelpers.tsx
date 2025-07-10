import React, { Suspense } from "react";
import { ClientRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Activity } from "lucide-react";
import PingTab from "../components/PingTab";

// OAuth Callback Rendering Helper
export const renderOAuthCallback = (
  onOAuthConnect: (
    serverUrl: string,
    transportType?: "sse" | "streamable-http",
  ) => Promise<void>,
  transportType?: "sse" | "streamable-http",
) => {
  const OAuthCallback = React.lazy(() => import("../components/OAuthCallback"));
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
      <Suspense
        fallback={
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
            <span className="text-muted-foreground">Loading...</span>
          </div>
        }
      >
        <OAuthCallback
          onConnect={onOAuthConnect}
          transportType={transportType}
        />
      </Suspense>
    </div>
  );
};

export const renderOAuthDebugCallback = (
  onOAuthDebugConnect: ({
    authorizationCode,
    errorMsg,
  }: {
    authorizationCode?: string;
    errorMsg?: string;
  }) => void,
) => {
  const OAuthDebugCallback = React.lazy(
    () => import("../components/OAuthDebugCallback"),
  );
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
      <Suspense
        fallback={
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
            <span className="text-muted-foreground">Loading...</span>
          </div>
        }
      >
        <OAuthDebugCallback onConnect={onOAuthDebugConnect} />
      </Suspense>
    </div>
  );
};

// Connection State Rendering Helpers
export const renderServerNotConnected = () => {
  return (
    <div className="flex flex-col items-center justify-center p-12 rounded-xl bg-card border border-border/50 shadow-sm">
      <Activity className="w-16 h-16 text-muted-foreground mb-4" />
      <h3 className="text-xl font-semibold mb-2">Connect to a server</h3>
      <p className="text-muted-foreground text-center mb-6 max-w-md">
        Please connect to a server to use the MCP Inspector.
      </p>
    </div>
  );
};

export const renderServerNoCapabilities = (
  sendMCPRequest: (
    request: ClientRequest,
    schema: z.ZodType,
  ) => Promise<unknown>,
) => {
  return (
    <div className="flex flex-col items-center justify-center p-12 rounded-xl bg-card border border-border/50 shadow-sm">
      <Activity className="w-16 h-16 text-muted-foreground mb-4" />
      <h3 className="text-xl font-semibold mb-2">No Capabilities Available</h3>
      <p className="text-muted-foreground text-center mb-6 max-w-md">
        The connected server does not support any MCP capabilities. You can
        still use the Ping feature to test connectivity.
      </p>
      <div className="w-full max-w-sm">
        <PingTab
          onPingClick={() => {
            void sendMCPRequest(
              {
                method: "ping" as const,
              },
              z.object({}),
            );
          }}
        />
      </div>
    </div>
  );
};
