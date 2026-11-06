import { getXAAIssuerUrl } from "@mcpjam/sdk";
import {
  HOSTED_MODE,
  LOCAL_SERVER_ADDR,
  MCPJAM_PUBLIC_ORIGIN,
} from "../config.js";
import { configuredInspectorPublicUrl } from "../utils/inspector-public-url.js";

/**
 * The MCPJam test-IdP issuer for a connect that has no inbound request to read
 * it from: the claim loops (scheduled eval runs, GitHub PR checks, Connector
 * Bench runs).
 *
 * It names the surface `resolveXaaIssuer` derives from a request, `/api/web/xaa`
 * hosted and `/api/mcp/xaa` otherwise, on the origin this deployment is
 * configured to be reached at. A background run's ID-JAG therefore carries the
 * `iss` an interactive run in the same project carries, and the manager builder
 * scopes it to the organization (`/o/<orgId>`, `/g/<orgId>`) in the same way.
 *
 * Hosted, the origin is the web tier's configured public URL and nothing else.
 * An authorization server fetches this issuer's discovery document and JWKS from
 * that origin, and a guessed one (the hosted default, localhost) would sign
 * assertions under another deployment's name. With no usable URL the result is
 * undefined, and a `useXaa` server fails closed in the manager builder instead
 * of minting. Off-hosted, a self-hosted deployment's public origin and then the
 * local server address stand in, as they do for links in API replies.
 */
export function resolveConfiguredXaaIssuer(
  hostedMode: boolean = HOSTED_MODE,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = configuredInspectorPublicUrl(env);
  // A configured URL is authoritative: one that does not parse yields no
  // issuer rather than a fallback, so a typo cannot pick another origin.
  const origin =
    configured !== undefined
      ? originOf(configured)
      : hostedMode
        ? undefined
        : originOf(MCPJAM_PUBLIC_ORIGIN ?? LOCAL_SERVER_ADDR);
  if (!origin) return undefined;
  return getXAAIssuerUrl(`${origin}${hostedMode ? "/api/web" : "/api/mcp"}`);
}

/** Scheme, host and port only, as `getIssuerForRequest` reads a request URL. */
function originOf(url: string): string | undefined {
  return URL.canParse(url) ? new URL(url).origin : undefined;
}
