import * as zod from 'zod';
import { ClientOptions, Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { Tool, ToolSet } from 'ai';
import { FlexibleSchema } from '@ai-sdk/provider-utils';

type ToolSchemaOverrides = Record<string, {
    inputSchema: FlexibleSchema<unknown>;
}>;
type ConvertedToolSet<SCHEMAS extends ToolSchemaOverrides | "automatic"> = SCHEMAS extends ToolSchemaOverrides ? {
    [K in keyof SCHEMAS]: Tool;
} : Record<string, Tool>;

type ClientCapabilityOptions = NonNullable<ClientOptions["capabilities"]>;
type BaseServerConfig = {
    capabilities?: ClientCapabilityOptions;
    timeout?: number;
    version?: string;
    onError?: (error: unknown) => void;
    logJsonRpc?: boolean;
    rpcLogger?: (event: {
        direction: "send" | "receive";
        message: unknown;
        serverId: string;
    }) => void;
};
type StdioServerConfig = BaseServerConfig & {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    url?: never;
    requestInit?: never;
    eventSourceInit?: never;
    authProvider?: never;
    reconnectionOptions?: never;
    sessionId?: never;
    preferSSE?: never;
};
type HttpServerConfig = BaseServerConfig & {
    url: URL;
    requestInit?: StreamableHTTPClientTransportOptions["requestInit"];
    eventSourceInit?: SSEClientTransportOptions["eventSourceInit"];
    authProvider?: StreamableHTTPClientTransportOptions["authProvider"];
    reconnectionOptions?: StreamableHTTPClientTransportOptions["reconnectionOptions"];
    sessionId?: StreamableHTTPClientTransportOptions["sessionId"];
    preferSSE?: boolean;
    command?: never;
    args?: never;
    env?: never;
};
type MCPServerConfig = StdioServerConfig | HttpServerConfig;
type MCPClientManagerConfig = Record<string, MCPServerConfig>;
type NotificationSchema = Parameters<Client["setNotificationHandler"]>[0];
type NotificationHandler = Parameters<Client["setNotificationHandler"]>[1];
type ClientRequestOptions = RequestOptions;
type CallToolOptions = RequestOptions;
type ListResourcesParams = Parameters<Client["listResources"]>[0];
type ListResourceTemplatesParams = Parameters<Client["listResourceTemplates"]>[0];
type ReadResourceParams = Parameters<Client["readResource"]>[0];
type SubscribeResourceParams = Parameters<Client["subscribeResource"]>[0];
type UnsubscribeResourceParams = Parameters<Client["unsubscribeResource"]>[0];
type ListPromptsParams = Parameters<Client["listPrompts"]>[0];
type GetPromptParams = Parameters<Client["getPrompt"]>[0];
type ListToolsResult = Awaited<ReturnType<Client["listTools"]>>;
type MCPConnectionStatus = "connected" | "connecting" | "disconnected";
type ServerSummary = {
    id: string;
    status: MCPConnectionStatus;
    config?: MCPServerConfig;
};
type ExecuteToolArguments = Record<string, unknown>;
type ElicitationHandler = (params: ElicitRequest["params"]) => Promise<ElicitResult> | ElicitResult;
declare class MCPClientManager {
    private readonly clientStates;
    private readonly notificationHandlers;
    private readonly elicitationHandlers;
    private readonly toolsMetadataCache;
    private readonly defaultClientVersion;
    private readonly defaultCapabilities;
    private readonly defaultTimeout;
    private defaultLogJsonRpc;
    private defaultRpcLogger?;
    private elicitationCallback?;
    private readonly pendingElicitations;
    constructor(servers?: MCPClientManagerConfig, options?: {
        defaultClientVersion?: string;
        defaultCapabilities?: ClientCapabilityOptions;
        defaultTimeout?: number;
        defaultLogJsonRpc?: boolean;
        rpcLogger?: (event: {
            direction: "send" | "receive";
            message: unknown;
            serverId: string;
        }) => void;
    });
    listServers(): string[];
    listConnectedServers(): string[];
    hasServer(serverId: string): boolean;
    getServerSummaries(): ServerSummary[];
    getConnectionStatus(serverId: string): MCPConnectionStatus;
    getServerConfig(serverId: string): MCPServerConfig | undefined;
    connectToServer(serverId: string, config: MCPServerConfig): Promise<Client>;
    disconnectServer(serverId: string): Promise<void>;
    removeServer(serverId: string): void;
    disconnectAllServers(): Promise<void>;
    listTools(serverId: string, params?: Parameters<Client["listTools"]>[0], options?: ClientRequestOptions): Promise<zod.objectOutputType<{
        _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
    } & {
        nextCursor: zod.ZodOptional<zod.ZodString>;
    } & {
        tools: zod.ZodArray<zod.ZodObject<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            description: zod.ZodOptional<zod.ZodString>;
            inputSchema: zod.ZodObject<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>;
            outputSchema: zod.ZodOptional<zod.ZodObject<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>>;
            annotations: zod.ZodOptional<zod.ZodObject<{
                title: zod.ZodOptional<zod.ZodString>;
                readOnlyHint: zod.ZodOptional<zod.ZodBoolean>;
                destructiveHint: zod.ZodOptional<zod.ZodBoolean>;
                idempotentHint: zod.ZodOptional<zod.ZodBoolean>;
                openWorldHint: zod.ZodOptional<zod.ZodBoolean>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                title: zod.ZodOptional<zod.ZodString>;
                readOnlyHint: zod.ZodOptional<zod.ZodBoolean>;
                destructiveHint: zod.ZodOptional<zod.ZodBoolean>;
                idempotentHint: zod.ZodOptional<zod.ZodBoolean>;
                openWorldHint: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                title: zod.ZodOptional<zod.ZodString>;
                readOnlyHint: zod.ZodOptional<zod.ZodBoolean>;
                destructiveHint: zod.ZodOptional<zod.ZodBoolean>;
                idempotentHint: zod.ZodOptional<zod.ZodBoolean>;
                openWorldHint: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">>>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            description: zod.ZodOptional<zod.ZodString>;
            inputSchema: zod.ZodObject<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>;
            outputSchema: zod.ZodOptional<zod.ZodObject<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>>;
            annotations: zod.ZodOptional<zod.ZodObject<{
                title: zod.ZodOptional<zod.ZodString>;
                readOnlyHint: zod.ZodOptional<zod.ZodBoolean>;
                destructiveHint: zod.ZodOptional<zod.ZodBoolean>;
                idempotentHint: zod.ZodOptional<zod.ZodBoolean>;
                openWorldHint: zod.ZodOptional<zod.ZodBoolean>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                title: zod.ZodOptional<zod.ZodString>;
                readOnlyHint: zod.ZodOptional<zod.ZodBoolean>;
                destructiveHint: zod.ZodOptional<zod.ZodBoolean>;
                idempotentHint: zod.ZodOptional<zod.ZodBoolean>;
                openWorldHint: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                title: zod.ZodOptional<zod.ZodString>;
                readOnlyHint: zod.ZodOptional<zod.ZodBoolean>;
                destructiveHint: zod.ZodOptional<zod.ZodBoolean>;
                idempotentHint: zod.ZodOptional<zod.ZodBoolean>;
                openWorldHint: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">>>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            description: zod.ZodOptional<zod.ZodString>;
            inputSchema: zod.ZodObject<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>;
            outputSchema: zod.ZodOptional<zod.ZodObject<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"object">;
                properties: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                required: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>>;
            annotations: zod.ZodOptional<zod.ZodObject<{
                title: zod.ZodOptional<zod.ZodString>;
                readOnlyHint: zod.ZodOptional<zod.ZodBoolean>;
                destructiveHint: zod.ZodOptional<zod.ZodBoolean>;
                idempotentHint: zod.ZodOptional<zod.ZodBoolean>;
                openWorldHint: zod.ZodOptional<zod.ZodBoolean>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                title: zod.ZodOptional<zod.ZodString>;
                readOnlyHint: zod.ZodOptional<zod.ZodBoolean>;
                destructiveHint: zod.ZodOptional<zod.ZodBoolean>;
                idempotentHint: zod.ZodOptional<zod.ZodBoolean>;
                openWorldHint: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                title: zod.ZodOptional<zod.ZodString>;
                readOnlyHint: zod.ZodOptional<zod.ZodBoolean>;
                destructiveHint: zod.ZodOptional<zod.ZodBoolean>;
                idempotentHint: zod.ZodOptional<zod.ZodBoolean>;
                openWorldHint: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">>>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, zod.ZodTypeAny, "passthrough">>, "many">;
    }, zod.ZodTypeAny, "passthrough">>;
    getTools(serverIds?: string[]): Promise<ListToolsResult>;
    getAllToolsMetadata(serverId: string): Record<string, Record<string, any>>;
    pingServer(serverId: string, options?: RequestOptions): void;
    getToolsForAiSdk(serverIds?: string[] | string, options?: {
        schemas?: ToolSchemaOverrides | "automatic";
    }): Promise<ToolSet>;
    executeTool(serverId: string, toolName: string, args?: ExecuteToolArguments, options?: CallToolOptions): Promise<zod.objectOutputType<{
        _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
    } & {
        content: zod.ZodDefault<zod.ZodArray<zod.ZodUnion<[zod.ZodObject<{
            type: zod.ZodLiteral<"text">;
            text: zod.ZodString;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
            type: zod.ZodLiteral<"text">;
            text: zod.ZodString;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
            type: zod.ZodLiteral<"text">;
            text: zod.ZodString;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
            type: zod.ZodLiteral<"image">;
            data: zod.ZodEffects<zod.ZodString, string, string>;
            mimeType: zod.ZodString;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
            type: zod.ZodLiteral<"image">;
            data: zod.ZodEffects<zod.ZodString, string, string>;
            mimeType: zod.ZodString;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
            type: zod.ZodLiteral<"image">;
            data: zod.ZodEffects<zod.ZodString, string, string>;
            mimeType: zod.ZodString;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
            type: zod.ZodLiteral<"audio">;
            data: zod.ZodEffects<zod.ZodString, string, string>;
            mimeType: zod.ZodString;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
            type: zod.ZodLiteral<"audio">;
            data: zod.ZodEffects<zod.ZodString, string, string>;
            mimeType: zod.ZodString;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
            type: zod.ZodLiteral<"audio">;
            data: zod.ZodEffects<zod.ZodString, string, string>;
            mimeType: zod.ZodString;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            uri: zod.ZodString;
            description: zod.ZodOptional<zod.ZodString>;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, {
            type: zod.ZodLiteral<"resource_link">;
        }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            uri: zod.ZodString;
            description: zod.ZodOptional<zod.ZodString>;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, {
            type: zod.ZodLiteral<"resource_link">;
        }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            uri: zod.ZodString;
            description: zod.ZodOptional<zod.ZodString>;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, {
            type: zod.ZodLiteral<"resource_link">;
        }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
            type: zod.ZodLiteral<"resource">;
            resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                text: zod.ZodString;
            }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                text: zod.ZodString;
            }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                text: zod.ZodString;
            }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                blob: zod.ZodEffects<zod.ZodString, string, string>;
            }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                blob: zod.ZodEffects<zod.ZodString, string, string>;
            }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                blob: zod.ZodEffects<zod.ZodString, string, string>;
            }>, zod.ZodTypeAny, "passthrough">>]>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
            type: zod.ZodLiteral<"resource">;
            resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                text: zod.ZodString;
            }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                text: zod.ZodString;
            }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                text: zod.ZodString;
            }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                blob: zod.ZodEffects<zod.ZodString, string, string>;
            }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                blob: zod.ZodEffects<zod.ZodString, string, string>;
            }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                blob: zod.ZodEffects<zod.ZodString, string, string>;
            }>, zod.ZodTypeAny, "passthrough">>]>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
            type: zod.ZodLiteral<"resource">;
            resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                text: zod.ZodString;
            }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                text: zod.ZodString;
            }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                text: zod.ZodString;
            }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                blob: zod.ZodEffects<zod.ZodString, string, string>;
            }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                blob: zod.ZodEffects<zod.ZodString, string, string>;
            }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                uri: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, {
                blob: zod.ZodEffects<zod.ZodString, string, string>;
            }>, zod.ZodTypeAny, "passthrough">>]>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, zod.ZodTypeAny, "passthrough">>]>, "many">>;
        structuredContent: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        isError: zod.ZodOptional<zod.ZodBoolean>;
    }, zod.ZodTypeAny, "passthrough"> | zod.objectOutputType<{
        _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
    } & {
        toolResult: zod.ZodUnknown;
    }, zod.ZodTypeAny, "passthrough">>;
    listResources(serverId: string, params?: ListResourcesParams, options?: ClientRequestOptions): Promise<zod.objectOutputType<{
        _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
    } & {
        nextCursor: zod.ZodOptional<zod.ZodString>;
    } & {
        resources: zod.ZodArray<zod.ZodObject<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            uri: zod.ZodString;
            description: zod.ZodOptional<zod.ZodString>;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            uri: zod.ZodString;
            description: zod.ZodOptional<zod.ZodString>;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            uri: zod.ZodString;
            description: zod.ZodOptional<zod.ZodString>;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, zod.ZodTypeAny, "passthrough">>, "many">;
    }, zod.ZodTypeAny, "passthrough">>;
    getResources(serverIds?: string[]): Promise<MCPResource[]>;
    getResourceTemplates(serverIds?: string[]): Promise<MCPResourceTemplate[]>;
    readResource(serverId: string, params: ReadResourceParams, options?: ClientRequestOptions): Promise<zod.objectOutputType<{
        _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
    } & {
        contents: zod.ZodArray<zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
            uri: zod.ZodString;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, {
            text: zod.ZodString;
        }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
            uri: zod.ZodString;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, {
            text: zod.ZodString;
        }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
            uri: zod.ZodString;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, {
            text: zod.ZodString;
        }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
            uri: zod.ZodString;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, {
            blob: zod.ZodEffects<zod.ZodString, string, string>;
        }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
            uri: zod.ZodString;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, {
            blob: zod.ZodEffects<zod.ZodString, string, string>;
        }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
            uri: zod.ZodString;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }, {
            blob: zod.ZodEffects<zod.ZodString, string, string>;
        }>, zod.ZodTypeAny, "passthrough">>]>, "many">;
    }, zod.ZodTypeAny, "passthrough">>;
    subscribeResource(serverId: string, params: SubscribeResourceParams, options?: ClientRequestOptions): Promise<{
        _meta?: zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough"> | undefined;
    }>;
    unsubscribeResource(serverId: string, params: UnsubscribeResourceParams, options?: ClientRequestOptions): Promise<{
        _meta?: zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough"> | undefined;
    }>;
    listResourceTemplates(serverId: string, params?: ListResourceTemplatesParams, options?: ClientRequestOptions): Promise<zod.objectOutputType<{
        _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
    } & {
        nextCursor: zod.ZodOptional<zod.ZodString>;
    } & {
        resourceTemplates: zod.ZodArray<zod.ZodObject<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            uriTemplate: zod.ZodString;
            description: zod.ZodOptional<zod.ZodString>;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            uriTemplate: zod.ZodString;
            description: zod.ZodOptional<zod.ZodString>;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            uriTemplate: zod.ZodString;
            description: zod.ZodOptional<zod.ZodString>;
            mimeType: zod.ZodOptional<zod.ZodString>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, zod.ZodTypeAny, "passthrough">>, "many">;
    }, zod.ZodTypeAny, "passthrough">>;
    listPrompts(serverId: string, params?: ListPromptsParams, options?: ClientRequestOptions): Promise<zod.objectOutputType<{
        _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
    } & {
        nextCursor: zod.ZodOptional<zod.ZodString>;
    } & {
        prompts: zod.ZodArray<zod.ZodObject<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            description: zod.ZodOptional<zod.ZodString>;
            arguments: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                name: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                required: zod.ZodOptional<zod.ZodBoolean>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                name: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                required: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                name: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                required: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            description: zod.ZodOptional<zod.ZodString>;
            arguments: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                name: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                required: zod.ZodOptional<zod.ZodBoolean>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                name: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                required: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                name: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                required: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
            name: zod.ZodString;
            title: zod.ZodOptional<zod.ZodString>;
        }, {
            description: zod.ZodOptional<zod.ZodString>;
            arguments: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                name: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                required: zod.ZodOptional<zod.ZodBoolean>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                name: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                required: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                name: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                required: zod.ZodOptional<zod.ZodBoolean>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
            _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
        }>, {
            icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                src: zod.ZodString;
                mimeType: zod.ZodOptional<zod.ZodString>;
                sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
            }, zod.ZodTypeAny, "passthrough">>, "many">>;
        }>, zod.ZodTypeAny, "passthrough">>, "many">;
    }, zod.ZodTypeAny, "passthrough">>;
    getPrompt(serverId: string, params: GetPromptParams, options?: ClientRequestOptions): Promise<zod.objectOutputType<{
        _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
    } & {
        description: zod.ZodOptional<zod.ZodString>;
        messages: zod.ZodArray<zod.ZodObject<{
            role: zod.ZodEnum<["user", "assistant"]>;
            content: zod.ZodUnion<[zod.ZodObject<{
                type: zod.ZodLiteral<"text">;
                text: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"text">;
                text: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"text">;
                text: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
                type: zod.ZodLiteral<"image">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"image">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"image">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
                type: zod.ZodLiteral<"audio">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"audio">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"audio">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
                name: zod.ZodString;
                title: zod.ZodOptional<zod.ZodString>;
            }, {
                uri: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }>, {
                icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">>, "many">>;
            }>, {
                type: zod.ZodLiteral<"resource_link">;
            }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
                name: zod.ZodString;
                title: zod.ZodOptional<zod.ZodString>;
            }, {
                uri: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }>, {
                icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">>, "many">>;
            }>, {
                type: zod.ZodLiteral<"resource_link">;
            }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
                name: zod.ZodString;
                title: zod.ZodOptional<zod.ZodString>;
            }, {
                uri: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }>, {
                icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">>, "many">>;
            }>, {
                type: zod.ZodLiteral<"resource_link">;
            }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
                type: zod.ZodLiteral<"resource">;
                resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">>]>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"resource">;
                resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">>]>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"resource">;
                resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">>]>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>]>;
        }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
            role: zod.ZodEnum<["user", "assistant"]>;
            content: zod.ZodUnion<[zod.ZodObject<{
                type: zod.ZodLiteral<"text">;
                text: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"text">;
                text: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"text">;
                text: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
                type: zod.ZodLiteral<"image">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"image">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"image">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
                type: zod.ZodLiteral<"audio">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"audio">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"audio">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
                name: zod.ZodString;
                title: zod.ZodOptional<zod.ZodString>;
            }, {
                uri: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }>, {
                icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">>, "many">>;
            }>, {
                type: zod.ZodLiteral<"resource_link">;
            }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
                name: zod.ZodString;
                title: zod.ZodOptional<zod.ZodString>;
            }, {
                uri: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }>, {
                icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">>, "many">>;
            }>, {
                type: zod.ZodLiteral<"resource_link">;
            }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
                name: zod.ZodString;
                title: zod.ZodOptional<zod.ZodString>;
            }, {
                uri: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }>, {
                icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">>, "many">>;
            }>, {
                type: zod.ZodLiteral<"resource_link">;
            }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
                type: zod.ZodLiteral<"resource">;
                resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">>]>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"resource">;
                resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">>]>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"resource">;
                resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">>]>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>]>;
        }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
            role: zod.ZodEnum<["user", "assistant"]>;
            content: zod.ZodUnion<[zod.ZodObject<{
                type: zod.ZodLiteral<"text">;
                text: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"text">;
                text: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"text">;
                text: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
                type: zod.ZodLiteral<"image">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"image">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"image">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
                type: zod.ZodLiteral<"audio">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"audio">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"audio">;
                data: zod.ZodEffects<zod.ZodString, string, string>;
                mimeType: zod.ZodString;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
                name: zod.ZodString;
                title: zod.ZodOptional<zod.ZodString>;
            }, {
                uri: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }>, {
                icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">>, "many">>;
            }>, {
                type: zod.ZodLiteral<"resource_link">;
            }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
                name: zod.ZodString;
                title: zod.ZodOptional<zod.ZodString>;
            }, {
                uri: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }>, {
                icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">>, "many">>;
            }>, {
                type: zod.ZodLiteral<"resource_link">;
            }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<zod.objectUtil.extendShape<zod.objectUtil.extendShape<{
                name: zod.ZodString;
                title: zod.ZodOptional<zod.ZodString>;
            }, {
                uri: zod.ZodString;
                description: zod.ZodOptional<zod.ZodString>;
                mimeType: zod.ZodOptional<zod.ZodString>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }>, {
                icons: zod.ZodOptional<zod.ZodArray<zod.ZodObject<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                    src: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    sizes: zod.ZodOptional<zod.ZodArray<zod.ZodString, "many">>;
                }, zod.ZodTypeAny, "passthrough">>, "many">>;
            }>, {
                type: zod.ZodLiteral<"resource_link">;
            }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<{
                type: zod.ZodLiteral<"resource">;
                resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">>]>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{
                type: zod.ZodLiteral<"resource">;
                resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">>]>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{
                type: zod.ZodLiteral<"resource">;
                resource: zod.ZodUnion<[zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    text: zod.ZodString;
                }>, zod.ZodTypeAny, "passthrough">>, zod.ZodObject<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, "passthrough", zod.ZodTypeAny, zod.objectOutputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">, zod.objectInputType<zod.objectUtil.extendShape<{
                    uri: zod.ZodString;
                    mimeType: zod.ZodOptional<zod.ZodString>;
                    _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
                }, {
                    blob: zod.ZodEffects<zod.ZodString, string, string>;
                }>, zod.ZodTypeAny, "passthrough">>]>;
                _meta: zod.ZodOptional<zod.ZodObject<{}, "passthrough", zod.ZodTypeAny, zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough">, zod.objectInputType<{}, zod.ZodTypeAny, "passthrough">>>;
            }, zod.ZodTypeAny, "passthrough">>]>;
        }, zod.ZodTypeAny, "passthrough">>, "many">;
    }, zod.ZodTypeAny, "passthrough">>;
    getSessionIdByServer(serverId: string): string | undefined;
    addNotificationHandler(serverId: string, schema: NotificationSchema, handler: NotificationHandler): void;
    onResourceListChanged(serverId: string, handler: NotificationHandler): void;
    onResourceUpdated(serverId: string, handler: NotificationHandler): void;
    onPromptListChanged(serverId: string, handler: NotificationHandler): void;
    getClient(serverId: string): Client | undefined;
    setElicitationHandler(serverId: string, handler: ElicitationHandler): void;
    clearElicitationHandler(serverId: string): void;
    setElicitationCallback(callback: (request: {
        requestId: string;
        message: string;
        schema: unknown;
    }) => Promise<ElicitResult> | ElicitResult): void;
    clearElicitationCallback(): void;
    getPendingElicitations(): Map<string, {
        resolve: (value: ElicitResult) => void;
        reject: (error: unknown) => void;
    }>;
    respondToElicitation(requestId: string, response: ElicitResult): boolean;
    private connectViaStdio;
    private connectViaHttp;
    private safeCloseTransport;
    private applyNotificationHandlers;
    private createNotificationDispatcher;
    private applyElicitationHandler;
    private ensureConnected;
    private resetState;
    private resolveConnectionStatus;
    private withTimeout;
    private buildCapabilities;
    private formatError;
    private wrapTransportForLogging;
    private resolveRpcLogger;
    private isMethodUnavailableError;
    private getTimeout;
    private isStdioConfig;
    private getClientById;
}
type MCPPromptListResult = Awaited<ReturnType<MCPClientManager["listPrompts"]>>;
type MCPPrompt = MCPPromptListResult["prompts"][number];
type MCPGetPromptResult = Awaited<ReturnType<MCPClientManager["getPrompt"]>>;
type MCPResourceListResult = Awaited<ReturnType<MCPClientManager["listResources"]>>;
type MCPResource = MCPResourceListResult["resources"][number];
type MCPReadResourceResult = Awaited<ReturnType<MCPClientManager["readResource"]>>;
type MCPResourceTemplateListResult = Awaited<ReturnType<MCPClientManager["listResourceTemplates"]>>;
type MCPResourceTemplate = MCPResourceTemplateListResult["resourceTemplates"][number];
type MCPResourceContent = NonNullable<MCPReadResourceResult>["contents"][number];
type MCPServerSummary = ServerSummary;
type MCPConvertedToolSet<SCHEMAS extends ToolSchemaOverrides | "automatic"> = ConvertedToolSet<SCHEMAS>;
type MCPToolSchemaOverrides = ToolSchemaOverrides;

type index_ElicitationHandler = ElicitationHandler;
type index_ExecuteToolArguments = ExecuteToolArguments;
type index_MCPClientManager = MCPClientManager;
declare const index_MCPClientManager: typeof MCPClientManager;
type index_MCPClientManagerConfig = MCPClientManagerConfig;
type index_MCPConnectionStatus = MCPConnectionStatus;
type index_MCPConvertedToolSet<SCHEMAS extends ToolSchemaOverrides | "automatic"> = MCPConvertedToolSet<SCHEMAS>;
type index_MCPGetPromptResult = MCPGetPromptResult;
type index_MCPPrompt = MCPPrompt;
type index_MCPPromptListResult = MCPPromptListResult;
type index_MCPReadResourceResult = MCPReadResourceResult;
type index_MCPResource = MCPResource;
type index_MCPResourceContent = MCPResourceContent;
type index_MCPResourceListResult = MCPResourceListResult;
type index_MCPResourceTemplate = MCPResourceTemplate;
type index_MCPResourceTemplateListResult = MCPResourceTemplateListResult;
type index_MCPServerConfig = MCPServerConfig;
type index_MCPServerSummary = MCPServerSummary;
type index_MCPToolSchemaOverrides = MCPToolSchemaOverrides;
declare namespace index {
  export { type index_ElicitationHandler as ElicitationHandler, type index_ExecuteToolArguments as ExecuteToolArguments, index_MCPClientManager as MCPClientManager, type index_MCPClientManagerConfig as MCPClientManagerConfig, type index_MCPConnectionStatus as MCPConnectionStatus, type index_MCPConvertedToolSet as MCPConvertedToolSet, type index_MCPGetPromptResult as MCPGetPromptResult, type index_MCPPrompt as MCPPrompt, type index_MCPPromptListResult as MCPPromptListResult, type index_MCPReadResourceResult as MCPReadResourceResult, type index_MCPResource as MCPResource, type index_MCPResourceContent as MCPResourceContent, type index_MCPResourceListResult as MCPResourceListResult, type index_MCPResourceTemplate as MCPResourceTemplate, type index_MCPResourceTemplateListResult as MCPResourceTemplateListResult, type index_MCPServerConfig as MCPServerConfig, type index_MCPServerSummary as MCPServerSummary, type index_MCPToolSchemaOverrides as MCPToolSchemaOverrides };
}

export { type ElicitationHandler, type ExecuteToolArguments, MCPClientManager, type MCPClientManagerConfig, type MCPConnectionStatus, type MCPConvertedToolSet, type MCPGetPromptResult, type MCPPrompt, type MCPPromptListResult, type MCPReadResourceResult, type MCPResource, type MCPResourceContent, type MCPResourceListResult, type MCPResourceTemplate, type MCPResourceTemplateListResult, type MCPServerConfig, type MCPServerSummary, type MCPToolSchemaOverrides, index as i };
