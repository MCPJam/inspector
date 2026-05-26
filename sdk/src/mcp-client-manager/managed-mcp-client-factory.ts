/**
 * Factory that picks between `OfficialSdkClientAdapter` (legacy upstream
 * Client + initialize handshake) and `StatelessMcpHttpPreviewClient`
 * (own-fetch stateless preview) based on the resolved per-server
 * `mcpProtocolVersion` pin.
 *
 * **Validate-then-route discipline.** Callers pass `mcpProtocolVersion`
 * already validated by `isKnownProtocolVersion` at the trust boundary
 * (Convex validator, `local-server-resolver.ts`, etc.). The factory uses
 * `isStatelessProtocolVersion` ONLY for routing — typo strings should
 * never reach here.
 *
 * **Transport gate.** The stateless preview supports Streamable HTTP
 * POST only. Stdio and legacy SSE / `preferSSE` configs throw
 * `StatelessRequiresHttpTransport` at the factory rather than letting a
 * half-baked client fail mysteriously on the first call.
 *
 * **Construction timing.** Called from `MCPClientManager.ts` once at
 * construction and once at HTTP transport normalization — the preview's
 * own-fetch needs the resolved URL + auth + 401 behavior to exist at
 * construction (see `upstream_v2alpha_extension_points`).
 */

import { Client, type ClientOptions, type Implementation } from "@modelcontextprotocol/client";
import {
  StatelessRequiresHttpTransport,
  type ManagedMcpClient,
} from "./managed-mcp-client.js";
import { OfficialSdkClientAdapter } from "./official-sdk-client-adapter.js";
import {
  StatelessMcpHttpPreviewClient,
  type StatelessMcpHttpPreviewClientOptions,
} from "./stateless-mcp-http-preview-client.js";
import {
  isStatelessProtocolVersion,
  type McpProtocolVersion,
} from "./mcp-protocol-version.js";
import type { RpcLogger } from "./types.js";

// Re-export so consumers can `import { McpProtocolVersion } from "@mcpjam/sdk"`
// rather than reaching into the protocol-version module.
export type { McpProtocolVersion };

/** Discriminator hint for the factory's transport-kind validation. */
export type TransportKind = "http" | "stdio" | "sse";

/**
 * Factory input. `mcpProtocolVersion` drives the legacy-vs-stateless
 * branch; the legacy and stateless payloads are both optional and
 * checked at runtime. The caller is responsible for supplying the
 * payload that matches the version family.
 */
export interface CreateManagedMcpClientArgs {
  /**
   * Resolved per-server protocol-version pin (already validated by
   * `isKnownProtocolVersion` at the trust boundary). Absent →
   * legacy path with SDK default version negotiation. When present
   * AND `isStatelessProtocolVersion` returns true → stateless path.
   */
  mcpProtocolVersion?: McpProtocolVersion;
  /** Required for both paths. */
  clientInfo: Implementation;
  /** Required for the legacy path. */
  clientOptions?: ClientOptions;
  /** Required for the stateless path. */
  transportKind?: TransportKind;
  /**
   * Required for the stateless path. `clientInfo` and `protocolVersion`
   * are injected by the factory from the top-level args, so the caller
   * does not duplicate them here.
   */
  preview?: Omit<
    StatelessMcpHttpPreviewClientOptions,
    "clientInfo" | "protocolVersion"
  >;
}

/**
 * Build a managed client. Pure function — no manager state.
 *
 *   - `mcpProtocolVersion` absent OR stateful (per `isStatelessProtocolVersion`)
 *     → wraps a fresh upstream `Client(clientInfo, clientOptions)` in
 *     `OfficialSdkClientAdapter`. Behavior byte-identical to direct
 *     upstream usage.
 *   - `mcpProtocolVersion` stateless → asserts `transportKind === "http"`,
 *     constructs a `StatelessMcpHttpPreviewClient` with the resolved HTTP
 *     config. Throws `StatelessRequiresHttpTransport` for stdio / sse.
 */
export function createManagedMcpClient(
  args: CreateManagedMcpClientArgs,
): ManagedMcpClient {
  const wantsStateless =
    args.mcpProtocolVersion !== undefined &&
    isStatelessProtocolVersion(args.mcpProtocolVersion);

  if (wantsStateless) {
    if (args.transportKind !== "http") {
      throw new StatelessRequiresHttpTransport(args.transportKind ?? "<unset>");
    }
    if (!args.preview) {
      throw new Error(
        "createManagedMcpClient: stateless protocol version requires `preview` options",
      );
    }
    return new StatelessMcpHttpPreviewClient({
      ...args.preview,
      clientInfo: args.clientInfo,
      protocolVersion: args.mcpProtocolVersion!,
    });
  }

  if (!args.clientOptions) {
    throw new Error(
      "createManagedMcpClient: legacy path requires `clientOptions`",
    );
  }
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

export type { RpcLogger };
