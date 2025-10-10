import * as zod from 'zod';
import { ClientOptions, Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

type ClientCapabilityOptions = NonNullable<ClientOptions['capabilities']>;
type BaseServerConfig = {
    capabilities?: ClientCapabilityOptions;
    timeout?: number;
    version?: string;
    onError?: (error: unknown) => void;
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
    requestInit?: StreamableHTTPClientTransportOptions['requestInit'];
    eventSourceInit?: SSEClientTransportOptions['eventSourceInit'];
    authProvider?: StreamableHTTPClientTransportOptions['authProvider'];
    reconnectionOptions?: StreamableHTTPClientTransportOptions['reconnectionOptions'];
    sessionId?: StreamableHTTPClientTransportOptions['sessionId'];
    preferSSE?: boolean;
    command?: never;
    args?: never;
    env?: never;
};
type MCPServerConfig = StdioServerConfig | HttpServerConfig;
type MCPClientManagerConfig = Record<string, MCPServerConfig>;
type NotificationSchema = Parameters<Client['setNotificationHandler']>[0];
type NotificationHandler = Parameters<Client['setNotificationHandler']>[1];
type ClientRequestOptions = RequestOptions;
type CallToolOptions = RequestOptions;
type ListResourcesParams = Parameters<Client['listResources']>[0];
type ListResourceTemplatesParams = Parameters<Client['listResourceTemplates']>[0];
type ReadResourceParams = Parameters<Client['readResource']>[0];
type SubscribeResourceParams = Parameters<Client['subscribeResource']>[0];
type UnsubscribeResourceParams = Parameters<Client['unsubscribeResource']>[0];
type ListPromptsParams = Parameters<Client['listPrompts']>[0];
type GetPromptParams = Parameters<Client['getPrompt']>[0];
type ListToolsResult = Awaited<ReturnType<Client['listTools']>>;
type ExecuteToolArguments = Record<string, unknown>;
type ElicitationHandler = (params: ElicitRequest['params']) => Promise<ElicitResult> | ElicitResult;
declare class MCPClientManager {
    private readonly clientStates;
    private readonly notificationHandlers;
    private readonly elicitationHandlers;
    private readonly defaultClientVersion;
    private readonly defaultCapabilities;
    private readonly defaultTimeout;
    constructor(servers?: MCPClientManagerConfig, options?: {
        defaultClientVersion?: string;
        defaultCapabilities?: ClientCapabilityOptions;
        defaultTimeout?: number;
    });
    listServers(): string[];
    hasServer(serverName: string): boolean;
    connectToServer(serverName: string, config: MCPServerConfig): Promise<Client>;
    disconnectServer(serverName: string): Promise<void>;
    disconnectAllServers(): Promise<void>;
    listTools(serverName: string, params?: Parameters<Client['listTools']>[0], options?: ClientRequestOptions): Promise<zod.objectOutputType<{
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
    getTools(names?: string[]): Promise<ListToolsResult>;
    executeTool(serverName: string, toolName: string, args?: ExecuteToolArguments, options?: CallToolOptions): Promise<zod.objectOutputType<{
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
    listResources(serverName: string, params?: ListResourcesParams, options?: ClientRequestOptions): Promise<zod.objectOutputType<{
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
    readResource(serverName: string, params: ReadResourceParams, options?: ClientRequestOptions): Promise<zod.objectOutputType<{
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
    subscribeResource(serverName: string, params: SubscribeResourceParams, options?: ClientRequestOptions): Promise<{
        _meta?: zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough"> | undefined;
    }>;
    unsubscribeResource(serverName: string, params: UnsubscribeResourceParams, options?: ClientRequestOptions): Promise<{
        _meta?: zod.objectOutputType<{}, zod.ZodTypeAny, "passthrough"> | undefined;
    }>;
    listResourceTemplates(serverName: string, params?: ListResourceTemplatesParams, options?: ClientRequestOptions): Promise<zod.objectOutputType<{
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
    listPrompts(serverName: string, params?: ListPromptsParams, options?: ClientRequestOptions): Promise<zod.objectOutputType<{
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
    getPrompt(serverName: string, params: GetPromptParams, options?: ClientRequestOptions): Promise<zod.objectOutputType<{
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
    getSessionIdByServer(serverName: string): string | undefined;
    addNotificationHandler(serverName: string, schema: NotificationSchema, handler: NotificationHandler): void;
    onResourceListChanged(serverName: string, handler: NotificationHandler): void;
    onResourceUpdated(serverName: string, handler: NotificationHandler): void;
    onPromptListChanged(serverName: string, handler: NotificationHandler): void;
    getClient(serverName: string): Client | undefined;
    setElicitationHandler(serverName: string, handler: ElicitationHandler): void;
    clearElicitationHandler(serverName: string): void;
    private connectViaStdio;
    private connectViaHttp;
    private safeCloseTransport;
    private applyNotificationHandlers;
    private createNotificationDispatcher;
    private applyElicitationHandler;
    private ensureConnected;
    private resetState;
    private withTimeout;
    private buildCapabilities;
    private formatError;
    private getTimeout;
    private isStdioConfig;
    private normalizeName;
    private getClientByName;
}

export { type ElicitationHandler, type ExecuteToolArguments, MCPClientManager, type MCPClientManagerConfig, type MCPServerConfig };
