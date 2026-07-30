/**
 * Factory that wraps a fresh upstream `@modelcontextprotocol/client` `Client`
 * in `OfficialSdkClientAdapter` so `MCPClientManager` can type its client state
 * as `ManagedMcpClient`.
 *
 * Since Phase 1B, both the 2026-07-28 modern era and the legacy era go through
 * the official `Client`: a modern pin is a `versionNegotiation` on
 * `clientOptions` (set by the manager via `resolveVersionNegotiation`), not a
 * branch to a second client implementation. The hand-rolled stateless preview
 * client was removed in Phase 1C.
 */

import {
  Client,
  type ClientOptions,
  type Implementation,
} from "@modelcontextprotocol/client";
import { type ManagedMcpClient } from "./managed-mcp-client.js";
import { DialectAwareJsonSchemaValidator } from "./dialect-aware-json-schema-validator.js";
import { OfficialSdkClientAdapter } from "./official-sdk-client-adapter.js";
import {
  LogLevelMetaClient,
  type LogLevelProvider,
} from "./log-level-meta-client.js";
import {
  TraceContextMetaClient,
  type ConnectionTraceContextProvider,
} from "./trace-context-meta-client.js";
import type { McpProtocolVersion } from "./mcp-protocol-version.js";
import { registerTasksExtensionEraGateTarget } from "./tasks-ext-era-gate.js";
import type { RpcLogger } from "./types.js";

export type { LogLevelProvider, ConnectionTraceContextProvider };

/**
 * Wrap an adapter in the `LogLevelMetaClient` decorator when a
 * `logLevelProvider` is supplied, else return the adapter untouched. Keeping
 * this here means both factory entry points get the decorator identically.
 */
function withLogLevelMeta(
  adapter: ManagedMcpClient,
  logLevelProvider?: LogLevelProvider,
): ManagedMcpClient {
  return logLevelProvider
    ? new LogLevelMetaClient(adapter, logLevelProvider)
    : adapter;
}

/**
 * Wrap in the `TraceContextMetaClient` decorator when a
 * `traceContextProvider` is supplied, else return the client untouched. No
 * provider means no `traceparent`/`tracestate`/`baggage` keys ever reach the
 * wire — the default, since MCPJam runs no OpenTelemetry tracer.
 */
function withTraceContextMeta(
  client: ManagedMcpClient,
  traceContextProvider?: ConnectionTraceContextProvider,
): ManagedMcpClient {
  return traceContextProvider
    ? new TraceContextMetaClient(client, traceContextProvider)
    : client;
}

/**
 * The single seam at which an upstream `Client` becomes a `ManagedMcpClient`,
 * and therefore the single place the `io.modelcontextprotocol/tasks` era-gate
 * shadow can learn which upstream instance sits behind a managed one: every
 * client that can ever issue an extension request passes through here (both
 * entry points below, including the manager's own `new Client(...)`, which
 * arrives via `wrapLegacyClient`).
 *
 * Registration only — it installs nothing and cannot throw. The shadow goes on
 * lazily, on the first extension tasks call, so a future client build that
 * renamed the private member breaks tasks rather than every connection. See
 * `tasks-ext-era-gate.ts` for the full rationale and the bump checklist.
 */
function manage(
  client: Client,
  logLevelProvider?: LogLevelProvider,
  traceContextProvider?: ConnectionTraceContextProvider,
): ManagedMcpClient {
  const adapter = new OfficialSdkClientAdapter(client);
  const logLevelWrapped = withLogLevelMeta(adapter, logLevelProvider);
  const managed = withTraceContextMeta(logLevelWrapped, traceContextProvider);
  // Every layer of the chain, so the lookup works whichever one a caller ends
  // up passing to `tasks-ext.ts` — the adapter, an intermediate decorator, or
  // the outermost value handed back.
  registerTasksExtensionEraGateTarget(adapter, client);
  registerTasksExtensionEraGateTarget(logLevelWrapped, client);
  registerTasksExtensionEraGateTarget(managed, client);
  return managed;
}

// Re-export so consumers can `import { McpProtocolVersion } from "@mcpjam/sdk"`
// rather than reaching into the protocol-version module.
export type { McpProtocolVersion };

/** Factory input for building a managed client over the official upstream Client. */
export interface CreateManagedMcpClientArgs {
  clientInfo: Implementation;
  clientOptions?: ClientOptions;
  /**
   * Optional live accessor for this server's per-request log level. When
   * provided, the returned client is wrapped in `LogLevelMetaClient`, which
   * injects `LOG_LEVEL_META_KEY` into `params._meta` on the modern era only
   * (legacy uses `logging/setLevel`). Omit to opt a connection out entirely.
   */
  logLevelProvider?: LogLevelProvider;
  /**
   * Optional live accessor for the ambient OpenTelemetry trace context to
   * propagate. When provided, the returned client is wrapped in
   * `TraceContextMetaClient`, which injects the reserved `traceparent` /
   * `tracestate` / `baggage` `_meta` keys on the modern era only. Omit (the
   * default everywhere in MCPJam) and no such key is ever emitted.
   */
  traceContextProvider?: ConnectionTraceContextProvider;
}

/**
 * Build a managed client: wrap a fresh upstream
 * `Client(clientInfo, clientOptions)` in `OfficialSdkClientAdapter`. Pure
 * function — no manager state. Modern-vs-legacy negotiation lives on
 * `clientOptions.versionNegotiation`, not here.
 */
export function createManagedMcpClient(
  args: CreateManagedMcpClientArgs
): ManagedMcpClient {
  if (!args.clientOptions) {
    throw new Error("createManagedMcpClient: `clientOptions` is required");
  }
  const inner = new Client(args.clientInfo, {
    ...args.clientOptions,
    // Default to the dialect-aware validator so declared draft-07 schemas
    // (every v1-SDK server) are validated rather than rejected. Applied after
    // the spread with a nullish fallback so a real caller-supplied validator
    // still wins, but an explicit `jsonSchemaValidator: undefined` does not
    // silently drop us back to `Client`'s rejecting upstream default.
    jsonSchemaValidator:
      args.clientOptions.jsonSchemaValidator ??
      new DialectAwareJsonSchemaValidator(),
  });
  return manage(inner, args.logLevelProvider, args.traceContextProvider);
}

/**
 * Helper for callers that already have an upstream `Client`. Wraps without
 * re-constructing. Pass `logLevelProvider` to layer on the modern
 * per-request logging opt-in, and `traceContextProvider` to layer on
 * OpenTelemetry trace-context propagation (see
 * {@link CreateManagedMcpClientArgs}).
 */
export function wrapLegacyClient(
  client: Client,
  logLevelProvider?: LogLevelProvider,
  traceContextProvider?: ConnectionTraceContextProvider,
): ManagedMcpClient {
  return manage(client, logLevelProvider, traceContextProvider);
}

export type { RpcLogger };
