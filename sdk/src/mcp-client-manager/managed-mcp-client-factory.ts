/**
 * Factory that picks between `OfficialSdkClientAdapter` (legacy) and
 * `StatelessDraft2026V1PreviewClient` based on the resolved outbound
 * `mcpWireMode`. Called from `MCPClientManager.ts` once at construction
 * and once at HTTP transport normalization (per plan §"Construction
 * timing" — the preview's own-fetch needs the resolved URL + auth +
 * 401 behavior to exist at construction).
 *
 * **Transport gate.** The stateless preview supports Streamable HTTP
 * POST only. Stdio and legacy SSE / `preferSSE` configs throw
 * `StatelessPreviewRequiresHttpTransport` at the factory rather than
 * letting a half-baked client fail mysteriously on the first call.
 */

import { Client, type ClientOptions, type Implementation } from "@modelcontextprotocol/client";
import {
  StatelessPreviewRequiresHttpTransport,
  type ManagedMcpClient,
} from "./managed-mcp-client.js";
import { OfficialSdkClientAdapter } from "./official-sdk-client-adapter.js";
import {
  StatelessDraft2026V1PreviewClient,
  type StatelessDraft2026V1PreviewClientOptions,
} from "./stateless-draft-2026-v1-preview-client.js";
import type { RpcLogger } from "./types.js";

export type McpWireMode = "legacy" | "stateless-draft-2026-v1";

/** Discriminator hint for the factory's transport-kind validation. */
export type TransportKind = "http" | "stdio" | "sse";

export interface CreateLegacyClientArgs {
  mcpWireMode?: "legacy";
  clientInfo: Implementation;
  clientOptions: ClientOptions;
}

export interface CreateStatelessPreviewClientArgs {
  mcpWireMode: "stateless-draft-2026-v1";
  transportKind: TransportKind;
  preview: Omit<StatelessDraft2026V1PreviewClientOptions, "clientInfo"> & {
    clientInfo: Implementation;
  };
}

export type CreateManagedMcpClientArgs =
  | CreateLegacyClientArgs
  | CreateStatelessPreviewClientArgs;

/**
 * Build a managed client. Pure function — no manager state.
 *
 *   - `legacy` → wraps a fresh upstream `Client(clientInfo, clientOptions)`
 *     in `OfficialSdkClientAdapter`. Behavior byte-identical to direct
 *     upstream usage.
 *   - `stateless-draft-2026-v1` → asserts `transportKind === "http"`,
 *     constructs a `StatelessDraft2026V1PreviewClient` with the
 *     resolved HTTP config. Throws `StatelessPreviewRequiresHttpTransport`
 *     for stdio / sse.
 */
export function createManagedMcpClient(
  args: CreateManagedMcpClientArgs,
): ManagedMcpClient {
  if (args.mcpWireMode === "stateless-draft-2026-v1") {
    if (args.transportKind !== "http") {
      throw new StatelessPreviewRequiresHttpTransport(args.transportKind);
    }
    return new StatelessDraft2026V1PreviewClient(args.preview);
  }
  // Default to legacy when undefined; matches the resolveEffective rule.
  const inner = new Client(args.clientInfo, args.clientOptions);
  return new OfficialSdkClientAdapter(inner);
}

/**
 * Helper for tests / callers that already have an upstream `Client`
 * (e.g. constructed early at `MCPClientManager.ts:1170` before the
 * factory was introduced). Wraps without re-constructing.
 */
export function wrapLegacyClient(client: Client): ManagedMcpClient {
  return new OfficialSdkClientAdapter(client);
}

// Re-export so consumers can `import { McpWireMode } from "@mcpjam/sdk"`
// rather than reaching into a sub-module.
export type { RpcLogger };
