/**
 * What this Inspector's server can do without the hosted app
 * (`GET /api/web/capabilities`; see `server/routes/web/capabilities.ts`).
 *
 * A self-hosted build (npx, Docker, desktop) holds no MCPJam service
 * credential, so a few features only work at app.mcpjam.com. Reading this lets
 * the UI leave those out instead of offering something that will refuse.
 */
import { useEffect, useState } from "react";

export interface ServerCapabilities {
  hostedMode: boolean;
  /** True when this server holds MCPJam's service credential. */
  hostedServices: boolean;
  hostedUrl: string;
  /** Feature ids that refuse here with the shared hosted-only answer. */
  hostedOnly: string[];
  /** Feature ids that work here without the credential, and how. */
  degraded: { id: string; via: "bearer" | "relay" }[];
}

let cached: Promise<ServerCapabilities | null> | null = null;

function isCapabilities(value: unknown): value is ServerCapabilities {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.hostedServices === "boolean" &&
    Array.isArray(record.hostedOnly)
  );
}

/**
 * Fetched once per page load. `null` when the server could not say (an older
 * server without the route, a network failure): callers treat that as
 * "unknown" and keep today's behaviour rather than hiding anything.
 */
export function fetchServerCapabilities(): Promise<ServerCapabilities | null> {
  // Started inside a `then` so a fetch that throws synchronously, or a test
  // double that returns nothing, lands in the `catch` as "unknown".
  cached ??= Promise.resolve()
    .then(() => fetch("/api/web/capabilities", { cache: "no-store" }))
    .then(async (response) => {
      if (!response?.ok) return null;
      const body: unknown = await response.json().catch(() => null);
      return isCapabilities(body) ? body : null;
    })
    .catch(() => null);
  return cached;
}

export function resetServerCapabilitiesForTests(): void {
  cached = null;
}

/** `true`/`false` once known; `null` while loading or when unknown. */
export function useServerSupportsFeature(featureId: string): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchServerCapabilities().then((capabilities) => {
      if (!alive || !capabilities) return;
      setSupported(!capabilities.hostedOnly.includes(featureId));
    });
    return () => {
      alive = false;
    };
  }, [featureId]);
  return supported;
}
