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
import type { McpProtocolVersion } from "./mcp-protocol-version.js";
import type { RpcLogger } from "./types.js";

// Re-export so consumers can `import { McpProtocolVersion } from "@mcpjam/sdk"`
// rather than reaching into the protocol-version module.
export type { McpProtocolVersion };

/** Factory input for building a managed client over the official upstream Client. */
export interface CreateManagedMcpClientArgs {
  clientInfo: Implementation;
  clientOptions?: ClientOptions;
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
  return new OfficialSdkClientAdapter(inner);
}

/**
 * Helper for callers that already have an upstream `Client`. Wraps without
 * re-constructing.
 */
export function wrapLegacyClient(client: Client): ManagedMcpClient {
  return new OfficialSdkClientAdapter(client);
}

export type { RpcLogger };
