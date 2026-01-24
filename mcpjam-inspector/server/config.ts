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

// CORS origins
export const CORS_ORIGINS = [
  "http://localhost:5173", // Vite dev server
  "http://localhost:8080", // Electron renderer dev server
  `http://localhost:${SERVER_PORT}`, // Hono server
  `http://127.0.0.1:${SERVER_PORT}`, // Hono server production
];

// Hosted mode for cloud deployments (Railway, etc.)
// When enabled, allows configured hosts for token delivery and disables STDIO transport
export const HOSTED_MODE = process.env.MCPJAM_HOSTED_MODE === "true";

// Allowed hosts for token delivery in hosted mode (comma-separated)
// These hosts will be allowed to receive session tokens in addition to localhost
export const ALLOWED_HOSTS = process.env.MCPJAM_ALLOWED_HOSTS
  ? process.env.MCPJAM_ALLOWED_HOSTS.split(",").map((h) => h.trim().toLowerCase())
  : [];

// STDIO transport disabled - always disabled in hosted mode (security: prevents RCE)
// Can also be manually disabled via MCPJAM_DISABLE_STDIO
export const STDIO_DISABLED =
  HOSTED_MODE || process.env.MCPJAM_DISABLE_STDIO === "true";
