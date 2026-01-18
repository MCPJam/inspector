/**
 * Web Mode Detection
 *
 * Determines if the server is running in "web mode" (public deployment)
 * vs "local mode" (localhost/Electron).
 *
 * In web mode:
 * - Only HTTPS MCP server connections are allowed (no stdio, no HTTP)
 * - This prevents RCE vulnerabilities from process spawning
 * - WorkOS OAuth is used for authentication
 *
 * Detection methods:
 * 1. Explicit: WEB_MODE=true environment variable
 * 2. Implicit: ALLOWED_ORIGINS is set (indicates public deployment)
 * 3. Implicit: Running on Railway (RAILWAY_ENVIRONMENT is set)
 */

/**
 * Check if the server is running in web mode.
 * Web mode restricts functionality for security in public deployments.
 */
export function isWebMode(): boolean {
  // Explicit web mode flag
  if (process.env.WEB_MODE === "true") {
    return true;
  }

  // Implicit: Railway deployment
  if (process.env.RAILWAY_ENVIRONMENT) {
    return true;
  }

  // Implicit: Custom allowed origins configured (indicates public deployment)
  if (process.env.ALLOWED_ORIGINS) {
    return true;
  }

  return false;
}

/**
 * Validate that a transport type is allowed in the current mode.
 * In web mode, only HTTPS connections are permitted.
 *
 * @param transport - The transport type: "stdio", "http", or "https"
 * @returns Object with allowed boolean and optional error message
 */
export function validateTransport(transport: string): {
  allowed: boolean;
  error?: string;
} {
  const webMode = isWebMode();

  if (!webMode) {
    // Local mode: all transports allowed
    return { allowed: true };
  }

  // Web mode: only HTTPS allowed
  const normalizedTransport = transport.toLowerCase();

  if (normalizedTransport === "stdio") {
    return {
      allowed: false,
      error:
        "stdio transport is not available in web mode. Use HTTPS remote servers instead.",
    };
  }

  if (normalizedTransport === "http") {
    return {
      allowed: false,
      error:
        "HTTP transport is not available in web mode. Use HTTPS for secure connections.",
    };
  }

  if (normalizedTransport === "sse" || normalizedTransport === "https") {
    return { allowed: true };
  }

  // Unknown transport - allow for forward compatibility but log warning
  return { allowed: true };
}

/**
 * Validate that a URL is allowed in the current mode.
 * In web mode, only HTTPS URLs are permitted.
 *
 * @param url - The URL to validate
 * @returns Object with allowed boolean and optional error message
 */
export function validateMcpServerUrl(url: string): {
  allowed: boolean;
  error?: string;
} {
  const webMode = isWebMode();

  if (!webMode) {
    // Local mode: all URLs allowed
    return { allowed: true };
  }

  // Web mode: only HTTPS URLs allowed
  try {
    const parsed = new URL(url);

    if (parsed.protocol === "https:") {
      return { allowed: true };
    }

    if (parsed.protocol === "http:") {
      return {
        allowed: false,
        error:
          "HTTP URLs are not allowed in web mode. Use HTTPS for secure connections.",
      };
    }

    return {
      allowed: false,
      error: `Protocol "${parsed.protocol}" is not allowed in web mode. Use HTTPS.`,
    };
  } catch {
    return {
      allowed: false,
      error: "Invalid URL format.",
    };
  }
}

/**
 * Get web mode status for client consumption.
 * Returns configuration that the client can use to adjust its UI.
 */
export function getWebModeConfig(): {
  webMode: boolean;
  allowedTransports: string[];
  features: {
    stdio: boolean;
    http: boolean;
    https: boolean;
  };
} {
  const webMode = isWebMode();

  if (webMode) {
    return {
      webMode: true,
      allowedTransports: ["https", "sse"],
      features: {
        stdio: false,
        http: false,
        https: true,
      },
    };
  }

  return {
    webMode: false,
    allowedTransports: ["stdio", "http", "https", "sse"],
    features: {
      stdio: true,
      http: true,
      https: true,
    },
  };
}
