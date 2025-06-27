import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  Request,
  Result,
  Notification,
  ServerCapabilities,
  ClientRequest,
  Progress,
  ResourceReference,
  PromptReference,
  CompleteResultSchema,
  McpError,
  ErrorCode,
  CreateMessageRequestSchema,
  CreateMessageResult,
  ListRootsRequestSchema,
  CreateMessageRequest,
  ElicitRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AIProvider,
  providerManager,
} from "@/lib/providers";
import {
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import packageJson from "../package.json";
import {
  getMCPProxyAddress,
  getMCPProxyAddressAsync,
  getMCPServerRequestMaxTotalTimeout,
  getMCPServerRequestTimeout,
  resetRequestTimeoutOnProgress,
} from "@/utils/configUtils";
import { InspectorConfig } from "./lib/configurationTypes";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  SSEClientTransport,
  SSEClientTransportOptions,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InspectorOAuthClientProvider } from "./lib/auth";
import { z } from "zod";
import { ConnectionStatus } from "./lib/constants";
import { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { toast } from "./lib/hooks/useToast";
import {
  StdErrNotificationSchema,
  StdErrNotification,
} from "./lib/notificationTypes";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { HttpServerDefinition, MCPJamServerConfig } from "@/lib/serverTypes";
import { ClientLogLevels } from "./hooks/helpers/types";
import { ChatLoopProvider, ChatLoop, QueryProcessor, ToolCaller } from "./lib/chatLoop";

// Add interface for extended MCP client with AI provider
export interface ExtendedMcpClient extends Client {
  aiProvider: AIProvider;
  processQuery: (
    query: string,
    tools: Tool[],
    onUpdate?: (content: string) => void,
    model?: string,
    provider?: string,
  ) => Promise<string>;
  chatLoop: (tools: Tool[]) => Promise<void>;
  cleanup: () => Promise<void>;
}

export class MCPJamClient extends Client<Request, Notification, Result> implements ChatLoopProvider, ToolCaller {
  clientTransport: Transport | undefined;
  serverConfig: MCPJamServerConfig;
  headers: HeadersInit;
  mcpProxyServerUrl: URL;
  connectionStatus: ConnectionStatus;
  serverCapabilities: ServerCapabilities | null;
  inspectorConfig: InspectorConfig;
  completionsSupported: boolean;
  bearerToken?: string;
  headerName?: string;
  onStdErrNotification?: (notification: StdErrNotification) => void;
  onPendingRequest?: (
    request: CreateMessageRequest,
    resolve: (result: CreateMessageResult) => void,
    reject: (error: Error) => void,
  ) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onElicitationRequest?: (request: any, resolve: any) => void;
  getRoots?: () => unknown[];
  addRequestHistory: (request: object, response?: object) => void;
  addClientLog: (message: string, level: ClientLogLevels) => void;
  private queryProcessor: QueryProcessor;

  constructor(
    serverConfig: MCPJamServerConfig,
    inspectorConfig: InspectorConfig,
    addRequestHistory: (request: object, response?: object) => void,
    addClientLog: (message: string, level: ClientLogLevels) => void,
    bearerToken?: string,
    headerName?: string,
    onStdErrNotification?: (notification: StdErrNotification) => void,
    onPendingRequest?: (
      request: CreateMessageRequest,
      resolve: (result: CreateMessageResult) => void,
      reject: (error: Error) => void,
    ) => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onElicitationRequest?: (request: any, resolve: any) => void,
    getRoots?: () => unknown[],
  ) {
    super(
      { name: "mcpjam-inspector", version: packageJson.version },
      {
        capabilities: {
          sampling: {},
          elicitation: {},
          roots: {
            listChanged: true,
          },
        },
      },
    );

    // Assign properties
    this.serverConfig = serverConfig;
    this.headers = {};
    this.mcpProxyServerUrl = new URL(
      `${getMCPProxyAddress(inspectorConfig)}/stdio`,
    );
    this.bearerToken = bearerToken;
    this.headerName = headerName;
    this.connectionStatus = "disconnected";
    this.serverCapabilities = null;
    this.completionsSupported = true;
    this.inspectorConfig = inspectorConfig;
    this.onStdErrNotification = onStdErrNotification;
    this.onPendingRequest = onPendingRequest;
    this.onElicitationRequest = onElicitationRequest;
    this.getRoots = getRoots;
    this.addRequestHistory = addRequestHistory;
    this.addClientLog = addClientLog;
    this.queryProcessor = new QueryProcessor(this);
  }

  // Get AI provider from ProviderManager
  get aiProvider(): AIProvider | null {
    return providerManager.getDefaultProvider();
  }

  async connectStdio() {
    const serverUrl = new URL(
      `${await getMCPProxyAddressAsync(this.inspectorConfig)}/stdio`,
    );

    // Type guard to ensure we have a stdio server config
    if (
      this.serverConfig.transportType === "stdio" &&
      "command" in this.serverConfig
    ) {
      serverUrl.searchParams.append("command", this.serverConfig.command);
      serverUrl.searchParams.append(
        "args",
        this.serverConfig.args?.join(" ") ?? "",
      );
      serverUrl.searchParams.append(
        "env",
        JSON.stringify(this.serverConfig.env ?? {}),
      );
    }

    serverUrl.searchParams.append("transportType", "stdio");

    const transportOptions: SSEClientTransportOptions = {
      eventSourceInit: {
        fetch: (
          url: string | URL | globalThis.Request,
          init: RequestInit | undefined,
        ) => fetch(url, { ...init, headers: this.headers }),
      },
      requestInit: {
        headers: this.headers,
      },
    };

    this.mcpProxyServerUrl = serverUrl;
    try {
      const command =
        "command" in this.serverConfig ? this.serverConfig.command : "unknown";
      this.addClientLog(
        `Connecting to MCP server via stdio: ${command}`,
        "info",
      );
      // We do this because we're proxying through the inspector server first.
      this.clientTransport = new SSEClientTransport(
        serverUrl,
        transportOptions,
      );
      await this.connect(this.clientTransport);
      this.connectionStatus = "connected";
      this.addClientLog(
        "Successfully connected to MCP server via stdio",
        "info",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.addClientLog(
        `Failed to connect to MCP server via stdio: ${errorMessage}`,
        "error",
      );
      console.error("Error connecting to MCP server:", error);
      this.connectionStatus = "error";
      throw error; // Re-throw to allow proper error handling
    }
  }

  async connectSSE() {
    try {
      const serverUrl = new URL(
        `${await getMCPProxyAddressAsync(this.inspectorConfig)}/sse`,
      );
      serverUrl.searchParams.append(
        "url",
        (this.serverConfig as HttpServerDefinition).url.toString(),
      );
      serverUrl.searchParams.append("transportType", "sse");
      const transportOptions: SSEClientTransportOptions = {
        eventSourceInit: {
          fetch: (
            url: string | URL | globalThis.Request,
            init: RequestInit | undefined,
          ) => fetch(url, { ...init, headers: this.headers }),
        },
        requestInit: {
          headers: this.headers,
        },
      };
      this.clientTransport = new SSEClientTransport(
        serverUrl,
        transportOptions,
      );
      this.mcpProxyServerUrl = serverUrl;
      this.addClientLog(
        `Connecting to MCP server via SSE: ${(this.serverConfig as HttpServerDefinition).url}`,
        "info",
      );
      await this.connect(this.clientTransport);
      this.connectionStatus = "connected";
      this.addClientLog("Successfully connected to MCP server via SSE", "info");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.addClientLog(
        `Failed to connect to MCP server via SSE: ${errorMessage}`,
        "error",
      );
      console.error("Error connecting to MCP server:", error);
      this.connectionStatus = "error";
      throw error; // Re-throw to allow proper error handling
    }
  }

  async connectStreamableHttp() {
    try {
      const serverUrl = new URL(
        `${await getMCPProxyAddressAsync(this.inspectorConfig)}/mcp`,
      );
      serverUrl.searchParams.append(
        "url",
        (this.serverConfig as HttpServerDefinition).url.toString(),
      );
      serverUrl.searchParams.append("transportType", "streamable-http");

      const transportOptions: StreamableHTTPClientTransportOptions = {
        requestInit: {
          headers: this.headers,
        },
        reconnectionOptions: {
          maxReconnectionDelay: 30000,
          initialReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 2,
        },
      };

      this.clientTransport = new StreamableHTTPClientTransport(
        serverUrl,
        transportOptions,
      );
      this.mcpProxyServerUrl = serverUrl;

      this.addClientLog(
        `Connecting to MCP server via Streamable HTTP: ${(this.serverConfig as HttpServerDefinition).url}`,
        "info",
      );

      // Log authorization headers for debugging (without exposing tokens)
      const headersObj = this.headers as Record<string, string>;
      const hasAuthHeader =
        headersObj["Authorization"] ||
        headersObj[this.headerName || "Authorization"];

      if (hasAuthHeader) {
        this.addClientLog(
          `Authorization headers configured for Streamable HTTP ${JSON.stringify(
            headersObj,
          )}`,
          "debug",
        );
      } else {
        this.addClientLog("No authorization headers configured", "warn");
      }

      await this.connect(this.clientTransport);
      this.connectionStatus = "connected";
      this.addClientLog(
        "Successfully connected to MCP server via Streamable HTTP",
        "info",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Check if this is an authorization error
      if (this.is401Error(error)) {
        this.addClientLog(
          `Authorization required for Streamable HTTP connection: ${errorMessage}`,
          "warn",
        );
        // Don't throw here - let the calling code handle the auth flow
        throw error;
      }

      this.addClientLog(
        `Failed to connect to MCP server via Streamable HTTP: ${errorMessage}`,
        "error",
      );
      console.error("Error connecting to MCP server:", error);
      this.connectionStatus = "error";
      throw error; // Re-throw to allow proper error handling
    }
  }

  async checkProxyHealth() {
    try {
      const proxyHealthUrl = new URL(
        `${await getMCPProxyAddressAsync(this.inspectorConfig)}/health`,
      );
      this.addClientLog("Checking MCP proxy server health", "debug");
      const proxyHealthResponse = await fetch(proxyHealthUrl);
      const proxyHealth = await proxyHealthResponse.json();
      if (proxyHealth?.status !== "ok") {
        this.addClientLog("MCP Proxy Server is not healthy", "error");
        throw new Error("MCP Proxy Server is not healthy");
      }
      this.addClientLog("MCP proxy server health check passed", "debug");
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.addClientLog(
        `Failed to connect to MCP Proxy Server: ${errorMessage}`,
        "error",
      );
      console.error("Couldn't connect to MCP Proxy Server", e);
      throw e;
    }
  }

  is401Error = (error: unknown): boolean => {
    return (
      (error instanceof SseError && error.code === 401) ||
      (error instanceof Error && error.message.includes("401")) ||
      (error instanceof Error && error.message.includes("Unauthorized")) ||
      // Handle StreamableHTTP specific errors
      (error instanceof Error && error.message.includes("HTTP 401")) ||
      (error instanceof Error &&
        error.message.includes("authentication required"))
    );
  };

  handleAuthError = async (error: unknown) => {
    if (this.is401Error(error)) {
      this.addClientLog(
        "Authentication error detected, attempting OAuth flow",
        "warn",
      );
      // Only handle OAuth for HTTP-based transports
      if (
        this.serverConfig.transportType !== "stdio" &&
        "url" in this.serverConfig &&
        this.serverConfig.url
      ) {
        try {
          const serverAuthProvider = new InspectorOAuthClientProvider(
            this.serverConfig.url.toString(),
          );

          // Check if we have valid tokens first
          const existingTokens = await serverAuthProvider.tokens();
          if (existingTokens?.access_token) {
            this.addClientLog(
              "Found existing OAuth tokens, attempting to use them",
              "debug",
            );
            // Try to use existing tokens - if they fail, we'll fall through to the auth flow
            return true;
          }

          this.addClientLog(
            "No valid tokens found, starting OAuth authorization flow",
            "info",
          );
          const result = await auth(serverAuthProvider, {
            serverUrl: this.serverConfig.url.toString(),
          });

          if (result === "AUTHORIZED") {
            this.addClientLog("OAuth authentication successful", "info");
            return true;
          } else {
            this.addClientLog("OAuth authentication failed", "error");
            return false;
          }
        } catch (authError) {
          this.addClientLog(
            `OAuth flow failed: ${authError instanceof Error ? authError.message : String(authError)}`,
            "error",
          );
          return false;
        }
      }
    }

    return false;
  };

  async connectToServer(_e?: unknown, retryCount: number = 0): Promise<void> {
    const MAX_RETRIES = 2; // Increased retries for auth flow

    try {
      await this.checkProxyHealth();
    } catch {
      this.connectionStatus = "error-connecting-to-proxy";
      this.addClientLog("Failed to connect to proxy server", "error");
      return;
    }

    try {
      this.addClientLog(
        `Attempting to connect to MCP server (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`,
        "info",
      );

      // Initialize headers
      const headers: HeadersInit = {};

      // Handle authentication for HTTP-based transports
      if (
        this.serverConfig.transportType !== "stdio" &&
        "url" in this.serverConfig &&
        this.serverConfig.url
      ) {
        this.addClientLog(
          "Setting up authentication for HTTP transport",
          "debug",
        );

        // Create an auth provider with the current server URL
        const serverAuthProvider = new InspectorOAuthClientProvider(
          this.serverConfig.url.toString(),
        );

        // Use manually provided bearer token if available, otherwise use OAuth tokens
        let token = this.bearerToken;
        if (!token) {
          try {
            const oauthTokens = await serverAuthProvider.tokens();
            token = oauthTokens?.access_token;
            if (token) {
              this.addClientLog(
                "Using OAuth access token for authentication",
                "debug",
              );
            }
          } catch {
            this.addClientLog("Failed to retrieve OAuth tokens", "warn");
          }
        } else {
          this.addClientLog("Using manually provided bearer token", "debug");
        }

        if (token) {
          const authHeaderName = this.headerName || "Authorization";
          headers[authHeaderName] = `Bearer ${token}`;
          this.addClientLog(
            "Bearer token configured for authentication",
            "debug",
          );
        } else {
          this.addClientLog(
            "No bearer token available for authentication",
            "warn",
          );
        }
      } else if (this.bearerToken) {
        // For stdio or when manually providing bearer token, still apply it
        const authHeaderName = this.headerName || "Authorization";
        headers[authHeaderName] = `Bearer ${this.bearerToken}`;
        this.addClientLog(
          "Bearer token configured for stdio transport",
          "debug",
        );
      }

      // Update the headers property with auth headers
      this.headers = { ...this.headers, ...headers };

      if (this.onStdErrNotification) {
        this.setNotificationHandler(
          StdErrNotificationSchema,
          this.onStdErrNotification,
        );
        this.addClientLog("StdErr notification handler configured", "debug");
      }

      try {
        switch (this.serverConfig.transportType) {
          case "stdio":
            await this.connectStdio();
            break;
          case "sse":
            await this.connectSSE();
            break;
          case "streamable-http":
            await this.connectStreamableHttp();
            break;
        }

        // Update server capabilities after successful connection
        this.serverCapabilities = this.getServerCapabilities() ?? null;
        this.addClientLog(
          `Server capabilities retrieved: ${JSON.stringify(this.serverCapabilities)}`,
          "debug",
        );

        const initializeRequest = {
          method: "initialize",
        };
        this.addRequestHistory(initializeRequest, {
          capabilities: this.serverCapabilities,
          serverInfo: this.getServerVersion(),
          instructions: this.getInstructions(),
        });
        this.addClientLog("MCP client initialization completed", "info");
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.addClientLog(
          `Failed to connect to MCP Server via the MCP Inspector Proxy: ${errorMessage}`,
          "error",
        );
        console.error(
          `Failed to connect to MCP Server via the MCP Inspector Proxy: ${this.getMCPProxyServerUrl()}:`,
          error,
        );

        // Handle authentication errors and retry
        if (retryCount < MAX_RETRIES) {
          const shouldRetry = await this.handleAuthError(error);
          if (shouldRetry) {
            this.addClientLog(
              `Retrying connection after auth flow (attempt ${retryCount + 1}/${MAX_RETRIES})`,
              "info",
            );
            // Clear any existing tokens that might be invalid
            if (
              this.serverConfig.transportType !== "stdio" &&
              "url" in this.serverConfig &&
              this.serverConfig.url
            ) {
              const serverAuthProvider = new InspectorOAuthClientProvider(
                this.serverConfig.url.toString(),
              );
              serverAuthProvider.clear();
              this.addClientLog(
                "Cleared potentially invalid OAuth tokens",
                "debug",
              );
            }
            return this.connectToServer(undefined, retryCount + 1);
          }
        }

        if (this.is401Error(error)) {
          // Don't set error state if we're about to redirect for auth
          this.connectionStatus = "error";
          this.addClientLog(
            "Authentication failed, connection terminated",
            "error",
          );
          return;
        }
        throw error;
      }
      this.completionsSupported = true; // Reset completions support on new connection

      if (this.onPendingRequest) {
        this.setRequestHandler(CreateMessageRequestSchema, (request) => {
          return new Promise((resolve, reject) => {
            this.onPendingRequest?.(request, resolve, reject);
          });
        });
      }

      if (this.onElicitationRequest) {
        this.setRequestHandler(ElicitRequestSchema, (request) => {
          return new Promise((resolve) => {
            this.onElicitationRequest?.(request, resolve);
          });
        });
      }

      if (this.getRoots) {
        this.setRequestHandler(ListRootsRequestSchema, async () => {
          return { roots: this.getRoots?.() ?? [] };
        });
        this.addClientLog("Roots request handler configured", "debug");
      }

      this.connectionStatus = "connected";
      this.addClientLog(
        "MCP client connection established successfully",
        "info",
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.addClientLog(`Connection failed: ${errorMessage}`, "error");
      console.error(e);
      this.connectionStatus = "error";
    }
  }

  getTransport() {
    return this.clientTransport;
  }

  getMCPProxyServerUrl() {
    return this.mcpProxyServerUrl;
  }

  async makeRequest<T extends z.ZodType>(
    request: ClientRequest,
    schema: T,
    options?: RequestOptions & { suppressToast?: boolean },
  ): Promise<z.output<T>> {
    console.log("makeRequestTriggered");
    this.addClientLog(`Making MCP request: ${request.method}`, "debug");
    try {
      const abortController = new AbortController();

      // prepare MCP Client request options
      const mcpRequestOptions: RequestOptions = {
        signal: options?.signal ?? abortController.signal,
        resetTimeoutOnProgress:
          options?.resetTimeoutOnProgress ??
          resetRequestTimeoutOnProgress(this.inspectorConfig),
        timeout:
          options?.timeout ?? getMCPServerRequestTimeout(this.inspectorConfig),
        maxTotalTimeout:
          options?.maxTotalTimeout ??
          getMCPServerRequestMaxTotalTimeout(this.inspectorConfig),
      };

      // If progress notifications are enabled, add an onprogress hook to the MCP Client request options
      // This is required by SDK to reset the timeout on progress notifications
      if (mcpRequestOptions.resetTimeoutOnProgress) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        mcpRequestOptions.onprogress = (_params: Progress) => {
          // Add progress notification to `Server Notification` window in the UI
          // TODO: Add Notification to UI
          this.addClientLog("Progress notification received", "debug");
        };
      }

      let response;
      try {
        response = await this.request(request, schema, mcpRequestOptions);
        this.addClientLog(`MCP request successful: ${request.method}`, "info");
        this.addRequestHistory(request, response);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.addClientLog(
          `MCP request failed: ${request.method} - ${errorMessage}`,
          "error",
        );
        this.addRequestHistory(request, { error: errorMessage });
        throw error;
      }

      return response;
    } catch (e: unknown) {
      if (!options?.suppressToast) {
        const errorString = (e as Error).message ?? String(e);
        this.addClientLog(
          `Request error (toast shown): ${errorString}`,
          "error",
        );
        toast({
          title: "Error",
          description: errorString,
          variant: "destructive",
        });
      }
      throw e;
    }
  }

  handleCompletion = async (
    ref: ResourceReference | PromptReference,
    argName: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<string[]> => {
    if (!this.completionsSupported) {
      this.addClientLog("Completions not supported by server", "debug");
      return [];
    }

    const request: ClientRequest = {
      method: "completion/complete",
      params: {
        argument: {
          name: argName,
          value,
        },
        ref,
      },
    };

    try {
      this.addClientLog(`Requesting completion for ${argName}`, "debug");
      const response = await this.makeRequest(request, CompleteResultSchema, {
        signal,
        suppressToast: true,
      });
      const completionCount = response?.completion.values?.length || 0;
      this.addClientLog(
        `Received ${completionCount} completion suggestions`,
        "debug",
      );
      return response?.completion.values || [];
    } catch (e: unknown) {
      // Disable completions silently if the server doesn't support them.
      // See https://github.com/modelcontextprotocol/specification/discussions/122
      if (e instanceof McpError && e.code === ErrorCode.MethodNotFound) {
        this.completionsSupported = false;
        this.addClientLog(
          "Completions disabled - server does not support them",
          "warn",
        );
        return [];
      }

      // Unexpected errors - show toast and rethrow
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.addClientLog(`Completion request failed: ${errorMessage}`, "error");
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
      throw e;
    }
  };

  async tools() {
    this.addClientLog("Listing available tools", "debug");
    const tools = await this.listTools();
    this.addClientLog(`Found ${tools.tools.length} tools`, "info");
    return tools;
  }

  async disconnect() {
    this.addClientLog("Disconnecting from MCP server", "info");
    await this.close();
    this.connectionStatus = "disconnected";
    if (this.serverConfig.transportType !== "stdio") {
      const authProvider = new InspectorOAuthClientProvider(
        (this.serverConfig as HttpServerDefinition).url.toString(),
      );
      authProvider.clear();
      this.addClientLog("OAuth tokens cleared", "debug");
    }
    this.serverCapabilities = null;
    this.addClientLog("MCP client disconnected successfully", "info");
  }

  async setServerCapabilities(capabilities: ServerCapabilities) {
    this.serverCapabilities = capabilities;
    this.addClientLog("Server capabilities updated", "debug");
  }

  async processQuery(
    query: string,
    tools: Tool[],
    onUpdate?: (content: string) => void,
    model: string = "claude-3-5-sonnet-latest",
    provider?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.queryProcessor.processQuery(query, tools, onUpdate, model, provider, signal);
  }

  async chatLoop(tools: Tool[]) {
    const chatLoop = new ChatLoop(this);
    return await chatLoop.start(tools);
  }

  async cleanup() {
    this.addClientLog("Cleaning up MCP client", "info");
    await this.close();
  }
}
