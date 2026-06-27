/**
 * Resolve the model credential the harness hands to the in-sandbox CLI — from
 * Convex, the way every other model key is handled (keys live in Convex, never
 * in the inspector env).
 *
 * The CLI makes its own model calls inside the sandbox, so — unlike the emulated
 * `/stream` path — it needs a real credential. This fetches the system **AI
 * Gateway** key (the same key chat uses) via a bearer-authed Convex endpoint:
 * one key serves Claude Code (Anthropic) and Codex (OpenAI), so MCPJam-provided
 * harness works out of the box without per-org BYOK. The endpoint is
 * enablement-gated, project-members only, rate-limited, and audited; failures
 * (disabled / not-a-member / rate-limited / no key) return non-2xx so the turn
 * fails closed.
 *
 * Backed by `convex/http.ts:/web/harness/model-credential` →
 * `internalResolveHarnessModelCredential`.
 */
import { logger } from "../logger.js";

export type HarnessModelCredential = {
  providerKey: "gateway";
  apiKey: string;
  baseUrl?: string;
};

export type HarnessModelCredentialResult =
  | { ok: true; credential: HarnessModelCredential }
  | { ok: false; status: number; error: string };

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for harness model credential");
  }
  return convexHttpUrl;
}

export async function fetchHarnessModelCredential(args: {
  projectId: string;
  modelId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<HarnessModelCredentialResult> {
  const url = new URL(
    "/web/harness/model-credential",
    getConvexHttpUrl()
  ).toString();
  const authorization = args.bearer.startsWith("Bearer ")
    ? args.bearer
    : `Bearer ${args.bearer}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify({ projectId: args.projectId, modelId: args.modelId }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[harness-model-credential] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach harness model-credential endpoint",
    };
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: `Harness model-credential returned ${response.status} with non-JSON body`,
    };
  }

  if (!response.ok || payload?.ok !== true || !payload?.credential) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Harness model-credential failed (${response.status})`,
    };
  }

  return {
    ok: true,
    credential: payload.credential as HarnessModelCredential,
  };
}
