/**
 * The readiness / interoperability channel — Phase 7 §15.4.
 *
 * Everything reported here is NON-MUST advice: SHOULD, RECOMMENDED, or MAY
 * strength. A readiness warning is attached to
 * `MCPConformanceResult.readiness` and is NEVER converted into a check result,
 * so it cannot change `passed`, any check status, or the category summary.
 * That separation is the point: a server that is fully conformant but awkward
 * to interoperate with should read as "conformant, with advice", never as a
 * failure — and a conformance verdict must stay a statement about MUSTs.
 *
 * Each warning carries the spec strength of the requirement it reflects, so a
 * reader can tell "the spec says you SHOULD" from "the spec says you MAY".
 */

import type { Tool } from "@modelcontextprotocol/client";
import { scanXMcpHeaderDeclarations } from "../mcp-client-manager/mcp-header-mirror.js";
import { listTools } from "../operations.js";
import type {
  MCPClientCheckContext,
  MCPReadinessSpecStrength,
  MCPReadinessWarning,
  MCPServerSurfaceSnapshot,
  RawHttpCheckContext,
} from "./types.js";
import {
  jsonRpcResult,
  modernHeaders,
  modernRequestBody,
  rawRequest,
} from "./raw-http.js";

/** Capabilities whose 2025-era mechanics were replaced in the 2026 revision. */
const DEPRECATED_MODERN_CAPABILITIES: Array<{
  key: string;
  advice: string;
}> = [
  {
    key: "logging",
    advice:
      "the logging capability advertises the removed logging/setLevel handshake; modern clients carry the log level per request",
  },
];

function warning(
  id: MCPReadinessWarning["id"],
  title: string,
  specStrength: MCPReadinessSpecStrength,
  message: string,
  details?: Record<string, unknown>
): MCPReadinessWarning {
  return { id, title, severity: "warning", specStrength, message, details };
}

function toolOrderWarning(
  first: string[],
  second: string[]
): MCPReadinessWarning | undefined {
  if (first.length === 0 || first.join("\u0000") === second.join("\u0000")) {
    return undefined;
  }

  return warning(
    "readiness-tool-order-deterministic",
    "Deterministic Tool Order",
    "SHOULD",
    "tools/list returned the tools in a different order on a repeated call; a stable order keeps client-side caches, diffs, and model prompts stable across calls",
    { firstListing: first, secondListing: second }
  );
}

function metadataQualityWarning(
  tools: Tool[],
  serverName: string | undefined
): MCPReadinessWarning | undefined {
  const missingDescription = tools
    .filter((tool) => !tool.description?.trim())
    .map((tool) => tool.name);
  const missingTitle = tools
    .filter((tool) => !tool.title?.trim() && !tool.annotations?.title?.trim())
    .map((tool) => tool.name);
  const problems: string[] = [];

  if (missingDescription.length > 0) {
    problems.push(`${missingDescription.length} tool(s) have no description`);
  }
  if (missingTitle.length > 0) {
    problems.push(
      `${missingTitle.length} tool(s) have no human-readable title`
    );
  }
  if (!serverName?.trim()) {
    problems.push("the server does not report an identity name");
  }

  if (problems.length === 0) {
    return undefined;
  }

  return warning(
    "readiness-metadata-quality",
    "Metadata Quality",
    "SHOULD",
    `Primitive metadata is incomplete: ${problems.join(
      "; "
    )}. Models and human operators both select primitives from this metadata`,
    { missingDescription, missingTitle }
  );
}

function deprecatedFeatureWarning(
  ctx: MCPClientCheckContext,
  capabilities: Record<string, unknown>
): MCPReadinessWarning | undefined {
  const findings: string[] = [];

  if (ctx.config.era === "modern") {
    for (const { key, advice } of DEPRECATED_MODERN_CAPABILITIES) {
      if (capabilities[key] !== undefined) {
        findings.push(advice);
      }
    }
    const resources = capabilities.resources;
    if (
      resources !== null &&
      typeof resources === "object" &&
      (resources as Record<string, unknown>).subscribe === true
    ) {
      findings.push(
        "resources.subscribe advertises the removed resources/subscribe flow; modern clients subscribe through subscriptions/listen"
      );
    }
  } else if (
    ctx.initializationInfo?.protocolVersion !== undefined &&
    ctx.initializationInfo.protocolVersion < "2025-11-25"
  ) {
    findings.push(
      `the negotiated revision ${ctx.initializationInfo.protocolVersion} is superseded; newer clients negotiate a later revision`
    );
  }

  if (findings.length === 0) {
    return undefined;
  }

  return warning(
    "readiness-deprecated-feature-use",
    "Deprecated Feature Use",
    "SHOULD",
    `Server advertises superseded functionality: ${findings.join("; ")}`,
    { findings }
  );
}

/**
 * Readiness advice observable from the client session, collected while the
 * connection is still open. Any failure here is swallowed: readiness is
 * advisory, so a probe that cannot run must never disturb the run.
 */
export async function collectClientReadiness(
  ctx: MCPClientCheckContext,
  surface: MCPServerSurfaceSnapshot
): Promise<MCPReadinessWarning[]> {
  const warnings: MCPReadinessWarning[] = [];

  try {
    const secondListing = await listTools(ctx.manager, {
      serverId: ctx.serverId,
    });
    const orderWarning = toolOrderWarning(
      surface.toolNames,
      secondListing.tools.map((tool) => tool.name)
    );
    if (orderWarning) {
      warnings.push(orderWarning);
    }
  } catch {
    // A server without tools (or one that failed the repeat listing) simply
    // yields no ordering advice.
  }

  const metadataWarning = metadataQualityWarning(
    surface.tools,
    ctx.initializationInfo?.serverVersion?.name
  );
  if (metadataWarning) {
    warnings.push(metadataWarning);
  }

  const deprecated = deprecatedFeatureWarning(
    ctx,
    surface.serverCapabilities ?? {}
  );
  if (deprecated) {
    warnings.push(deprecated);
  }

  return warnings;
}

async function cacheTtlWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  if (ctx.config.era !== "modern") {
    return undefined;
  }

  const version = ctx.config.protocolVersion ?? "2026-07-28";
  const result = await rawRequest(ctx, {
    headers: modernHeaders({ protocolVersion: version, method: "tools/list" }),
    body: modernRequestBody({
      id: 8100,
      method: "tools/list",
      protocolVersion: version,
    }),
  });

  const ttlMs = jsonRpcResult(result)?.ttlMs;
  if (typeof ttlMs !== "number" || ttlMs > 0) {
    return undefined;
  }

  return warning(
    "readiness-cache-ttl-useful",
    "Useful Cache TTLs",
    "SHOULD",
    "Cacheable results advertise ttlMs: 0, so no client can reuse them; a non-zero TTL on stable listings removes a round trip per call",
    { method: "tools/list", ttlMs }
  );
}

/**
 * SEP-2243 `x-mcp-header` declarations, on the ADVICE channel.
 *
 * The MUST is `tools-x-mcp-header-declarations-valid`; this is the
 * interoperability half of the same observation, said in the words an operator
 * needs. The spec's consequence for a bad declaration is not "the header is
 * skipped" — a conforming client treats the whole TOOL DEFINITION as invalid
 * and drops it from `tools/list`, so the tool silently disappears from that
 * client. A pass/fail verdict does not convey that; this does.
 *
 * Raw, for the same unavoidable reason as the check: the official client
 * applies the exclusion itself, so `surface.tools` never contains an offender
 * and a client-side scan would always come back clean.
 */
async function xMcpHeaderDeclarationsWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  if (ctx.config.era !== "modern") {
    // Before 2026-07-28 the annotation carries no meaning; advising on it
    // would invent a requirement the revision never stated.
    return undefined;
  }

  const version = ctx.config.protocolVersion ?? "2026-07-28";
  const result = await rawRequest(ctx, {
    headers: modernHeaders({ protocolVersion: version, method: "tools/list" }),
    body: modernRequestBody({
      id: 8110,
      method: "tools/list",
      protocolVersion: version,
    }),
  });

  const tools = jsonRpcResult(result)?.tools;
  if (!Array.isArray(tools)) return undefined;

  const invalid: Array<{ tool: string; reason: string }> = [];
  for (const entry of tools as Array<Record<string, unknown>>) {
    if (entry.inputSchema === undefined) continue;
    const scan = scanXMcpHeaderDeclarations(entry.inputSchema);
    if (!scan.valid) {
      invalid.push({
        tool: typeof entry.name === "string" ? entry.name : "<unnamed>",
        reason: scan.reason,
      });
    }
  }
  if (invalid.length === 0) return undefined;

  return warning(
    "readiness-x-mcp-header-declarations",
    "x-mcp-header Declarations",
    "SHOULD",
    `${invalid.length} tool(s) declare x-mcp-header in a way SEP-2243 does not permit: ${invalid
      .map((entry) => `${entry.tool} (${entry.reason})`)
      .join(
        "; "
      )}. Clients that implement the mirroring exclude these tools from tools/list entirely, so they become invisible rather than merely losing a header`,
    { invalid }
  );
}

function metadataUrl(serverUrl: string, wellKnown: string): string {
  const url = new URL(serverUrl);
  return new URL(wellKnown, `${url.protocol}//${url.host}`).toString();
}

async function fetchJson(
  ctx: RawHttpCheckContext,
  url: string
): Promise<Record<string, unknown> | undefined> {
  const result = await rawRequest(ctx, {
    url,
    method: "GET",
    includeBaseHeaders: false,
    headers: { Accept: "application/json" },
  });
  return result.status === 200 &&
    result.json !== null &&
    typeof result.json === "object"
    ? (result.json as Record<string, unknown>)
    : undefined;
}

/**
 * RFC 9207 advises an authorization server to echo `iss` on the authorization
 * response so a client can detect mix-up attacks. It is RECOMMENDED, not
 * required, so its absence is advice — probed only when the resource actually
 * advertises OAuth metadata.
 */
async function oauthIssWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  const resourceMetadata = await fetchJson(
    ctx,
    metadataUrl(ctx.serverUrl, "/.well-known/oauth-protected-resource")
  );
  const authorizationServers = resourceMetadata?.authorization_servers;
  const issuer = Array.isArray(authorizationServers)
    ? authorizationServers[0]
    : undefined;
  if (typeof issuer !== "string") {
    return undefined;
  }

  const asMetadata = await fetchJson(
    ctx,
    metadataUrl(issuer, "/.well-known/oauth-authorization-server")
  );
  if (!asMetadata) {
    return undefined;
  }

  return asMetadata.authorization_response_iss_parameter_supported === true
    ? undefined
    : warning(
        "readiness-oauth-iss-advertised",
        "Authorization Response iss",
        "RECOMMENDED",
        `Authorization server ${issuer} does not advertise authorization_response_iss_parameter_supported; emitting iss lets clients detect authorization-server mix-up attacks`,
        { issuer }
      );
}

/**
 * Readiness advice that only the raw wire (or unauthenticated metadata
 * endpoints) can show. Each probe is independently guarded: readiness is
 * advisory, so a probe that throws contributes nothing and never fails a run.
 */
export async function collectRawReadiness(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning[]> {
  const probes = [
    cacheTtlWarning(ctx),
    oauthIssWarning(ctx),
    xMcpHeaderDeclarationsWarning(ctx),
  ];
  const settled = await Promise.allSettled(probes);
  return settled.flatMap((outcome) =>
    outcome.status === "fulfilled" && outcome.value ? [outcome.value] : []
  );
}
