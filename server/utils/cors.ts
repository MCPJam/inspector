import { CORS_ORIGINS, SERVER_HOSTNAME } from "../config";

type CorsOptions = {
  allowCredentials?: boolean;
  allowHeaders?: string;
  allowMethods?: string;
  exposeHeaders?: string;
  maxAge?: string;
  requestPrivateNetwork?: boolean;
  allowPrivateNetwork?: boolean;
};

const normalizedAllowedOrigins = new Set(
  CORS_ORIGINS.map((origin) => normalizeOrigin(origin)),
);

const allowedHostnames = new Set(
  [SERVER_HOSTNAME, "localhost", "127.0.0.1", "::1"].map((host) =>
    host.toLowerCase(),
  ),
);

function normalizeOrigin(origin: string) {
  return origin.trim().replace(/\/$/, "").toLowerCase();
}

function extractHostname(hostHeader: string | null | undefined) {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing !== -1) return trimmed.slice(1, closing).toLowerCase();
  }
  return trimmed.split(":")[0]?.toLowerCase() ?? null;
}

export function getAllowedOrigin(originHeader: string | null | undefined) {
  if (!originHeader) return null;
  const normalized = normalizeOrigin(originHeader);
  return normalizedAllowedOrigins.has(normalized) ? normalized : null;
}

export function isAllowedHost(hostHeader: string | null | undefined) {
  const hostname = extractHostname(hostHeader);
  if (!hostname) return true;
  return allowedHostnames.has(hostname);
}

export function buildCorsHeaders(
  originHeader: string | null | undefined,
  options: CorsOptions = {},
) {
  const allowedOrigin = getAllowedOrigin(originHeader);
  const headers: Record<string, string> = { Vary: "Origin" };

  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    if (options.allowCredentials) {
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    if (
      options.allowPrivateNetwork &&
      options.requestPrivateNetwork &&
      originHeader
    ) {
      headers["Access-Control-Allow-Private-Network"] = "true";
    }
  }

  if (options.allowMethods) {
    headers["Access-Control-Allow-Methods"] = options.allowMethods;
  }
  if (options.allowHeaders) {
    headers["Access-Control-Allow-Headers"] = options.allowHeaders;
  }
  if (options.exposeHeaders) {
    headers["Access-Control-Expose-Headers"] = options.exposeHeaders;
  }
  if (options.maxAge) {
    headers["Access-Control-Max-Age"] = options.maxAge;
  }

  return { headers, allowedOrigin };
}
