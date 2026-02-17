/**
 * Server configuration constants
 */

function parseMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// Server port - can be overridden via environment variable
export const SERVER_PORT = process.env.SERVER_PORT
  ? parseInt(process.env.SERVER_PORT, 10)
  : 6274;

// Server hostname
export const SERVER_HOSTNAME =
  process.env.ENVIRONMENT === "dev" ? "localhost" : "127.0.0.1";

// Local server address for tunneling
export const LOCAL_SERVER_ADDR = `http://localhost:${SERVER_PORT}`;

// Hosted mode for cloud deployments (Railway, etc.)
// Uses VITE_ prefix so the same variable works for both server and client build
export const HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE === "true";
export const HOSTED_STRICT_SECURITY =
  process.env.VITE_MCPJAM_HOSTED_STRICT_SECURITY === "true";

// Exact origins allowed for hosted web routes and CORS
export const WEB_ALLOWED_ORIGINS = (process.env.WEB_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173", // Vite dev server
  "http://localhost:8080", // Electron renderer dev server
  `http://localhost:${SERVER_PORT}`, // Hono server
  `http://127.0.0.1:${SERVER_PORT}`, // Hono server production
  "https://staging.app.mcpjam.com", // Hosted deployment
];

// CORS origins:
// - Hosted mode: exact allowlist from WEB_ALLOWED_ORIGINS (if provided).
// - Local mode: defaults + WEB_ALLOWED_ORIGINS (to support local testing with hosted origins).
export const CORS_ORIGINS =
  HOSTED_MODE && WEB_ALLOWED_ORIGINS.length > 0
    ? WEB_ALLOWED_ORIGINS
    : Array.from(new Set([...DEFAULT_CORS_ORIGINS, ...WEB_ALLOWED_ORIGINS]));

// Hosted web route timing contracts
export const WEB_CONNECT_TIMEOUT_MS = parseMs(
  process.env.WEB_CONNECT_TIMEOUT_MS,
  10_000,
);
export const WEB_CALL_TIMEOUT_MS = parseMs(process.env.WEB_CALL_TIMEOUT_MS, 30_000);
export const WEB_STREAM_TIMEOUT_MS = parseMs(
  process.env.WEB_STREAM_TIMEOUT_MS,
  120_000,
);

export const WEB_RATE_LIMIT_ENABLED = process.env.WEB_RATE_LIMIT_ENABLED === "true";
export const WEB_RATE_LIMIT_REQUESTS_PER_MINUTE = parseMs(
  process.env.WEB_RATE_LIMIT_REQUESTS_PER_MINUTE,
  120,
);

// Allowed hosts for token delivery in hosted mode (comma-separated)
// These hosts will be allowed to receive session tokens in addition to localhost
export const ALLOWED_HOSTS = process.env.MCPJAM_ALLOWED_HOSTS
  ? process.env.MCPJAM_ALLOWED_HOSTS.split(",").map((h) =>
      h.trim().toLowerCase(),
    )
  : [];
