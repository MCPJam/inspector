import { HOSTED_MODE } from "@/lib/config";
import { authFetch } from "@/lib/session-token";
import { getHostedXaaIdpUrls } from "./idp-endpoints";
import { createDebugRequestExecutor } from "@/lib/oauth/debug-state-machine-adapter";
import { createXAAStateMachine } from "./state-machine";
import type {
  BaseXAAStateMachineConfig,
  XAARequestExecutor,
  XAARequestResult,
  XAAStateMachine,
} from "./types";

const XAA_API_BASE = HOSTED_MODE ? "/api/web/xaa" : "/api/mcp/xaa";

function responseHeadersToRecord(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}

function normalizeHeaders(
  headers?: HeadersInit | Record<string, string>,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [key, String(value)]),
    );
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}

async function readResponseBody(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  try {
    return await response.text();
  } catch {
    return null;
  }
}

export function createXAADebugRequestExecutor(): XAARequestExecutor {
  const debugRequestExecutor = createDebugRequestExecutor();

  return {
    internalRequest: async (
      path: string,
      init?: RequestInit,
    ): Promise<XAARequestResult> => {
      // authFetch attaches the hosted bearer to the local mint paths (see
      // HOSTED_AUTH_PATH_PREFIXES) and, crucially, refreshes-and-retries on a
      // 401 — so a stale/expired hosted token self-heals rather than stranding
      // the flow. Manual header injection would have made authFetch treat the
      // auth as caller-provided and skip that retry.
      const response = await authFetch(`${XAA_API_BASE}${path}`, init);
      const body = await readResponseBody(response);

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeadersToRecord(response),
        body,
        ok: response.ok,
      };
    },
    externalRequest: async (
      url: string,
      init?: RequestInit,
    ): Promise<XAARequestResult> => {
      return debugRequestExecutor({
        url,
        method: init?.method || "GET",
        headers: normalizeHeaders(init?.headers),
        body: init?.body,
        // CIMD document preflights use "manual" so a 3xx is observable (the
        // draft forbids the AS from following redirects) instead of silently
        // followed. Hosted httpsOnly forces manual regardless.
        ...(init?.redirect === "manual" || init?.redirect === "follow"
          ? { redirect: init.redirect }
          : {}),
      });
    },
  };
}

export function createInspectorXAAStateMachine(
  config: Omit<
    BaseXAAStateMachineConfig,
    "issuerBaseUrl" | "mintPathPrefix" | "requestExecutor"
  > & {
    // Ground-truth issuer resolved from the server's OpenID config. Falls back
    // to the browser-origin guess, which is wrong when the browser reaches the
    // API through the Vite dev proxy (browser :5173, backend :6274).
    issuerBaseUrl?: string;
    // Hosted runs mint under the org-scoped issuer (/o/<orgId>) when the user
    // belongs to an organization; local runs and guests stay unscoped.
    organizationId?: string | null;
    // LOCAL runs only: "hosted" mints via app.mcpjam.com (forwarded by the
    // local server) so a cloud AS can discover the issuer. Ignored on hosted
    // builds — hosted IS the hosted issuer.
    issuerMode?: "local" | "hosted";
  },
): XAAStateMachine {
  const { issuerBaseUrl, organizationId, issuerMode, ...rest } = config;
  const hostedIssuerOptIn = !HOSTED_MODE && issuerMode === "hosted";
  const mintPathPrefix =
    HOSTED_MODE && organizationId ? `/o/${organizationId}` : "";
  const defaultIssuerBaseUrl = hostedIssuerOptIn
    ? getHostedXaaIdpUrls(organizationId).issuerBaseUrl
    : `${window.location.origin}${XAA_API_BASE}${mintPathPrefix}`;
  return createXAAStateMachine({
    ...rest,
    issuerBaseUrl: issuerBaseUrl ?? defaultIssuerBaseUrl,
    mintPathPrefix,
    ...(hostedIssuerOptIn ? { issuerMode: "hosted", organizationId } : {}),
    requestExecutor: createXAADebugRequestExecutor(),
  });
}
