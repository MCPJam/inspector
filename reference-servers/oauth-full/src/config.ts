import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export interface ReferenceServerConfig {
  /** TCP port to listen on. */
  port: number;
  /** Origin advertised in metadata (issuer, endpoints). Defaults to http://localhost:<port>. Set to a tunnel URL when exposing to remote clients (ChatGPT, Claude web). */
  publicUrl: string;
  /** Label for the current capture run — normally the client under test (e.g. "claude", "cursor"). */
  label: string;
  /** Directory where per-run capture JSON files are written. */
  captureDir: string;
  /** Access-token lifetime in seconds. Use something short (e.g. 60) to force refresh during a session. */
  accessTokenTtl: number;
  /** Advertise + accept Dynamic Client Registration. Disable to probe clients' no-DCR fallback. */
  dcr: boolean;
  /** Issue refresh tokens. Disable to probe re-auth behavior on expiry. */
  refreshTokens: boolean;
  /** Reject token requests that omit the RFC 8707 `resource` parameter (strict mode). Default: record but accept. */
  requireResource: boolean;
  /** Reject authorization requests without PKCE. Default true (2025-06-18+ behavior); disable to let non-PKCE clients complete the flow while the gap is recorded. */
  requirePkce: boolean;
  /** Show a manual consent page at /authorize instead of instantly redirecting. */
  consentPage: boolean;
  /** Trusted external issuer for XAA / ID-JAG jwt-bearer redemption (RFC 7523). JWKS is fetched from <issuer>/.well-known/jwks.json. Empty = grant disabled. */
  xaaIssuer: string;
}

export const PREREGISTERED_CLIENT_ID = "oauth-ref-preregistered";
export const PREREGISTERED_CLIENT_SECRET = "oauth-ref-preregistered-secret";

export const SUPPORTED_SCOPES = [
  "mcp:tools",
  "mcp:resources",
  "mcp:prompts",
  "offline_access",
] as const;

/** Scopes hinted in the WWW-Authenticate challenge. Deliberately a strict
 * subset of SUPPORTED_SCOPES so we can distinguish clients that request
 * exactly the challenge scopes ("challenge-derived") from clients that
 * request everything the PRM advertises ("all-advertised"). */
export const CHALLENGE_SCOPES = ["mcp:tools", "mcp:resources", "mcp:prompts"] as const;

export function parseConfig(argv: string[]): ReferenceServerConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: process.env.PORT ?? "4747" },
      "public-url": { type: "string", default: "" },
      label: { type: "string", default: "unlabeled" },
      "capture-dir": { type: "string", default: "" },
      "access-ttl": { type: "string", default: "3600" },
      "no-dcr": { type: "boolean", default: false },
      "no-refresh": { type: "boolean", default: false },
      "require-resource": { type: "boolean", default: false },
      "allow-no-pkce": { type: "boolean", default: false },
      consent: { type: "boolean", default: false },
      "xaa-issuer": { type: "string", default: "" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${values.port}`);
  }
  const accessTokenTtl = Number(values["access-ttl"]);
  if (!Number.isFinite(accessTokenTtl) || accessTokenTtl <= 0) {
    throw new Error(`Invalid --access-ttl: ${values["access-ttl"]}`);
  }

  const publicUrl = (values["public-url"] || `http://localhost:${port}`).replace(/\/+$/, "");

  return {
    port,
    publicUrl,
    label: values.label ?? "unlabeled",
    captureDir: values["capture-dir"] || fileURLToPath(new URL("../captures", import.meta.url)),
    accessTokenTtl,
    dcr: !values["no-dcr"],
    refreshTokens: !values["no-refresh"],
    requireResource: values["require-resource"] ?? false,
    requirePkce: !values["allow-no-pkce"],
    consentPage: values.consent ?? false,
    xaaIssuer: (values["xaa-issuer"] ?? "").replace(/\/+$/, ""),
  };
}

function printHelp(): void {
  console.log(`
MCPJam OAuth reference server (HP-10)

Full-capability MCP server (tools, resources, prompts, apps/UI, logging,
elicitation, completions) gated behind an embedded OAuth authorization server
(RFC 9728 PRM, RFC 8414 metadata, DCR, CIMD, PKCE S256, refresh rotation,
optional XAA/ID-JAG jwt-bearer). Every request is captured per labeled run and
distilled into per-client OAuth traits + an HP-1 oauthProfile.

Usage: npm run start -w @mcpjam/oauth-reference-server -- [flags]

  --port <n>            Listen port (default 4747, env PORT)
  --public-url <url>    Advertised origin (default http://localhost:<port>).
                        Set to your tunnel URL for remote clients.
  --label <name>        Capture label — the client under test (default "unlabeled").
                        Can be switched at runtime: POST /capture/reset {"label":"cursor"}
  --capture-dir <dir>   Where capture JSON lands (default ./captures)
  --access-ttl <sec>    Access-token TTL (default 3600; use 60 to force refresh)
  --no-dcr              Do not advertise/accept Dynamic Client Registration
  --no-refresh          Do not issue refresh tokens
  --require-resource    Reject token requests missing the RFC 8707 resource param
  --allow-no-pkce       Let non-PKCE clients complete the flow (gap still recorded)
  --consent             Show a manual consent page instead of auto-approving
  --xaa-issuer <url>    Trust this issuer for XAA/ID-JAG jwt-bearer redemption
`);
}
