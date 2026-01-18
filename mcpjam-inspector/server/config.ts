/**
 * Server configuration constants
 */

// Server port - can be overridden via environment variable
// Railway and other PaaS providers use PORT, so check that first
export const SERVER_PORT = process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : process.env.SERVER_PORT
    ? parseInt(process.env.SERVER_PORT, 10)
    : 6274;

// Server hostname
export const SERVER_HOSTNAME =
  process.env.ENVIRONMENT === "dev" ? "localhost" : "127.0.0.1";

// Local server address for tunneling
export const LOCAL_SERVER_ADDR = `http://localhost:${SERVER_PORT}`;

// CORS origins - includes localhost for development and any configured ALLOWED_ORIGINS for web deployments
export const CORS_ORIGINS = [
  "http://localhost:5173", // Vite dev server
  "http://localhost:8080", // Electron renderer dev server
  `http://localhost:${SERVER_PORT}`, // Hono server
  `http://127.0.0.1:${SERVER_PORT}`, // Hono server production
  // Include configured origins for web mode (Railway, etc.)
  ...(process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) || []),
];
