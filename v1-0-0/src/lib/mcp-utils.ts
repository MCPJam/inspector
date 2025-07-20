import { NextResponse } from "next/server";
import { MCPClient } from "@mastra/mcp";
import { MastraMCPServerDefinition, HttpServerDefinition } from "./types";
import { OAuthClientState } from "./oauth-types";

export interface ValidationResult {
  success: boolean;
  config?: MastraMCPServerDefinition;
  error?: NextResponse;
}

export function validateServerConfig(serverConfig: any): ValidationResult {
  if (!serverConfig) {
    return {
      success: false,
      error: NextResponse.json(
        { error: "Server configuration is required" },
        { status: 400 },
      ),
    };
  }

  // Validate and prepare config
  const config = { ...serverConfig };

  // Validate and convert URL if provided
  if (config.url) {
    try {
      // Convert string URL to URL object if needed
      if (typeof config.url === "string") {
        config.url = new URL(config.url);
      } else if (typeof config.url === "object" && !config.url.href) {
        return {
          success: false,
          error: NextResponse.json(
            { error: "Invalid URL configuration" },
            { status: 400 },
          ),
        };
      }

      // Handle OAuth authentication for HTTP servers
      if (config.oauth?.access_token) {
        const authHeaders = {
          Authorization: `Bearer ${config.oauth.access_token}`,
          ...(config.requestInit?.headers || {}),
        };

        config.requestInit = {
          ...config.requestInit,
          headers: authHeaders,
        };

        // For SSE connections, add eventSourceInit with OAuth headers
        config.eventSourceInit = {
          fetch(input: Request | URL | string, init?: RequestInit) {
            const headers = new Headers(init?.headers || {});

            // Add OAuth authorization header
            headers.set(
              "Authorization",
              `Bearer ${config.oauth!.access_token}`,
            );

            // Copy other headers from requestInit
            if (config.requestInit?.headers) {
              const requestHeaders = new Headers(config.requestInit.headers);
              requestHeaders.forEach((value, key) => {
                if (key.toLowerCase() !== "authorization") {
                  headers.set(key, value);
                }
              });
            }

            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      } else if (config.requestInit?.headers) {
        // For SSE connections without OAuth, add eventSourceInit if requestInit has custom headers
        config.eventSourceInit = {
          fetch(input: Request | URL | string, init?: RequestInit) {
            const headers = new Headers(init?.headers || {});

            // Copy headers from requestInit
            const requestHeaders = new Headers(config.requestInit.headers);
            requestHeaders.forEach((value, key) => {
              headers.set(key, value);
            });

            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      }
    } catch (error) {
      return {
        success: false,
        error: NextResponse.json(
          { error: "Invalid URL format" },
          { status: 400 },
        ),
      };
    }
  }

  return {
    success: true,
    config,
  };
}

export function createMCPClient(
  config: MastraMCPServerDefinition,
  id: string,
): MCPClient {
  return new MCPClient({
    id,
    servers: {
      server: config,
    },
  });
}

export function createErrorResponse(
  message: string,
  details?: string,
  status: number = 500,
): NextResponse {
  return NextResponse.json(
    {
      error: message,
      details: details || "Unknown error",
    },
    { status },
  );
}
