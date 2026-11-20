/**
 * Browser side of POST /api/release/dispatch. The route holds the write
 * token and re-checks the signed-in employee; this only sends the choice.
 */

export interface DispatchRequest {
  action: "start" | "publish" | "none";
  deploy_backend_prod: boolean;
  deploy_webapp: boolean;
  deploy_mcp_production: boolean;
  skip_verify: boolean;
}

export type DispatchResult =
  | { kind: "ok"; message: string }
  | { kind: "partial"; message: string }
  | { kind: "error"; message: string };

export async function dispatchRelease(
  body: DispatchRequest
): Promise<DispatchResult> {
  try {
    const res = await fetch("/api/release/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Same-origin sentinel; the route rejects POSTs without it (CSRF).
        "x-soundcheck-action": "release-dispatch"
      },
      body: JSON.stringify(body)
    });
    const json = (await res.json()) as {
      error?: string;
      message?: string;
      partial?: boolean;
    };
    if (!res.ok) {
      return { kind: "error", message: json.error ?? `Dispatch failed: ${res.status}` };
    }
    return {
      kind: json.partial ? "partial" : "ok",
      message: json.message ?? "Started."
    };
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
}
