/**
 * Server configuration constants
 */

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

export const NON_PROD_LOCKDOWN = process.env.MCPJAM_NONPROD_LOCKDOWN === "true";

export const EMPLOYEE_EMAIL_DOMAINS = (
  process.env.MCPJAM_EMPLOYEE_EMAIL_DOMAINS ?? ""
)
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter((domain) => domain.length > 0);

export function isAllowedEmployeeEmail(
  email: string | null | undefined
): boolean {
  if (!email || EMPLOYEE_EMAIL_DOMAINS.length === 0) {
    return false;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const atIndex = normalizedEmail.lastIndexOf("@");
  if (atIndex === -1) {
    return false;
  }

  const emailDomain = normalizedEmail.slice(atIndex + 1);
  return EMPLOYEE_EMAIL_DOMAINS.includes(emailDomain);
}

// Exact origins allowed for hosted web routes and CORS
export const WEB_ALLOWED_ORIGINS = (process.env.WEB_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const CLIENT_PORT = process.env.CLIENT_PORT || "5173";

const DEFAULT_CORS_ORIGINS = [
  `http://localhost:${CLIENT_PORT}`, // Vite dev server
  "http://localhost:8080", // Electron renderer dev server
  `http://localhost:${SERVER_PORT}`, // Hono server
  `http://127.0.0.1:${SERVER_PORT}`, // Hono server production
  "https://staging.mcpjam.com", // Hosted deployment
];

// CORS origins:
// - Hosted mode: exact allowlist from WEB_ALLOWED_ORIGINS (if provided).
// - Local mode: defaults + WEB_ALLOWED_ORIGINS (to support local testing with hosted origins).
export const CORS_ORIGINS =
  HOSTED_MODE && WEB_ALLOWED_ORIGINS.length > 0
    ? WEB_ALLOWED_ORIGINS
    : Array.from(new Set([...DEFAULT_CORS_ORIGINS, ...WEB_ALLOWED_ORIGINS]));

// Hosted web route timeouts (ms)
export const WEB_CONNECT_TIMEOUT_MS = 10_000;
export const WEB_CALL_TIMEOUT_MS = 30_000;
export const WEB_STREAM_TIMEOUT_MS = 120_000;

// Allowed hosts for token delivery in hosted mode (comma-separated)
// These hosts will be allowed to receive session tokens in addition to localhost
export const ALLOWED_HOSTS = process.env.MCPJAM_ALLOWED_HOSTS
  ? process.env.MCPJAM_ALLOWED_HOSTS.split(",").map((h) =>
      h.trim().toLowerCase()
    )
  : [];
