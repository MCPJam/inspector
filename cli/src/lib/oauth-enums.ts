export const VALID_PROTOCOL_VERSIONS = new Set([
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
]);

// Protocol versions whose OAuth spec supports Client ID Metadata Documents.
export const CIMD_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2026-07-28"]);

export const VALID_REGISTRATION_STRATEGIES = new Set([
  "cimd",
  "dcr",
  "preregistered",
]);

export const VALID_AUTH_MODES = new Set([
  "headless",
  "interactive",
  "client_credentials",
]);
