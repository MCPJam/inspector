/**
 * A gateway connection as the backend describes it (`organizationModelProviders`
 * rows with `apis`, `models` and `lastTest`), and the connection Test's result.
 * Mirrors the backend's `convex/lib/gatewayConnectionValidators.ts` and
 * `gatewayConnectionProbe.ts`: the editor reads a backend Test and an
 * Inspector-run Test through the same shape.
 */

export const GATEWAY_APIS = [
  "chatCompletions",
  "responses",
  "anthropicMessages",
  "embeddings",
] as const;

export type GatewayApi = (typeof GATEWAY_APIS)[number];

export const GATEWAY_API_LABELS: Record<GatewayApi, string> = {
  chatCompletions: "Chat Completions",
  responses: "Responses",
  anthropicMessages: "Anthropic Messages",
  embeddings: "Embeddings",
};

export type GatewayCapability =
  "tools" | "vision" | "structuredOutput" | "reasoning";

/** `declared` is an admin's correction and wins over `measured` until cleared. */
export type GatewayCapabilityObservation = {
  status: "supported" | "unsupported" | "unknown";
  source: "measured" | "declared";
  observedAt: number;
};

export type GatewayModel = {
  /** The gateway's own model name; may contain `/`. */
  nativeModelId: string;
  /** The catalog model it serves (`provider/model`); absent means unmapped. */
  modelId?: string;
  mappingSource?: "admin" | "gateway" | "name";
  capabilities?: Partial<
    Record<GatewayCapability, GatewayCapabilityObservation>
  >;
};

export type GatewayApiTestResult = "ok" | "failed" | "untested";

export type GatewayLastTest = {
  at: number;
  origin: "backend" | "inspector";
  ok: boolean;
  message?: string;
  apis: Partial<Record<GatewayApi, GatewayApiTestResult>>;
};

/**
 * One Test of a gateway: from MCPJam's servers (`backend`) or from the
 * Inspector that runs the connection's calls (`inspector`).
 */
export type GatewayConnectionTestResult = {
  reachable: boolean;
  origin: "backend" | "inspector";
  refusal?: { code: string; message: string };
  status?: number;
  message?: string;
  apis: Partial<
    Record<
      GatewayApi,
      { result: GatewayApiTestResult; status?: number; message?: string }
    >
  >;
  models: Array<{
    nativeModelId: string;
    suggestedModelId?: string;
    suggestionSource?: "gateway" | "name";
  }>;
};

/** Admins paste the base URL with or without the API version. */
function withoutApiVersion(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

const GATEWAY_PATHS = {
  models: "/models",
  modelInfo: "/model/info",
  chatCompletions: "/chat/completions",
  anthropicMessages: "/messages",
  responses: "/responses",
  embeddings: "/embeddings",
} as const;

export type GatewayEndpoint = keyof typeof GATEWAY_PATHS;

/** `{base}/v1/<path>` for one endpoint, from either spelling of the base URL. */
export function gatewayApiUrl(
  baseUrl: string,
  endpoint: GatewayEndpoint,
): string {
  return `${withoutApiVersion(baseUrl)}/v1${GATEWAY_PATHS[endpoint]}`;
}

/** The host of a typed URL, or null when it doesn't parse. */
export function gatewayHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.trim()).host || null;
  } catch {
    // Still being typed; there is no host to show yet.
    return null;
  }
}

/**
 * What two base URLs are compared on: origin and path, version dropped. The
 * backend compares the same way when it decides a repointed connection needs
 * its key again.
 */
export function gatewayBaseKey(baseUrl: string): string {
  const bare = withoutApiVersion(baseUrl);
  try {
    const url = new URL(bare);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    // Not a URL: compared as typed, which still tells two inputs apart.
    return bare;
  }
}
