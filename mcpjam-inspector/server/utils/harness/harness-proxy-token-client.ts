/**
 * Fetch per-server harness MCP proxy tokens from Convex — the same bearer-authed
 * channel the harness already uses for `session-state` and the model broker.
 *
 * Convex MINTS the tokens (it knows the authenticated user, so identity is
 * authoritative and baked in) and checks per-server access; the inspector only
 * verifies + forwards.
 *
 * Backed by `convex/http.ts:/web/harness/mcp-proxy-token`.
 */
import { logger } from "../logger.js";

/**
 * What the run FROZE about tool-call evidence, reported by the mint.
 *
 * Present only on a claim-bearing mint, and only when the control plane
 * authorized the iteration — so its absence means "no authorized eval scope",
 * which is a different fact from a scope that froze capture off. The proxy
 * arms capture on `captureEnabled`; the merge reads `gradingSource`.
 */
export type HarnessEvidenceDecision = {
  captureEnabled: boolean;
  gradingSource: "narration" | "evidence";
};

export type HarnessProxyTokensResult =
  | {
      ok: true;
      tokens: Record<string, string>;
      harnessEvidence?: HarnessEvidenceDecision;
    }
  | { ok: false; status: number; error: string };

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for harness proxy tokens");
  }
  return convexHttpUrl;
}

/**
 * Mint a token per server.
 *
 * ALL-OR-NOTHING on both axes. A server the caller cannot access fails the
 * whole mint with a 422 naming it (`malformed` / `unauthorized`), and so does
 * an eval scope the caller cannot claim. There is no partial success and no
 * fallback: this function returns a typed failure and `runHarnessTurn` refuses
 * to run, because a turn that quietly lost half its tools — or all of its
 * evidence — is far worse to debug than one that stopped.
 *
 * `evalScope` asks for tokens carrying an AUTHORIZED iteration claim. Passing
 * it does not assert anything: the control plane re-derives the run from the
 * iteration and checks it against this caller, so the claim on the token is
 * its decision, not ours. Omit it for playground traffic, which mints
 * claimless tokens exactly as before.
 */
export async function fetchHarnessProxyTokens(args: {
  projectId: string;
  serverIds: string[];
  bearer: string;
  signal?: AbortSignal;
  evalScope?: { iterationId: string };
}): Promise<HarnessProxyTokensResult> {
  // Missing/invalid endpoint config must stay on the result contract (like the
  // network-error path below), not escape as a throw.
  let url: string;
  try {
    url = new URL(
      "/web/harness/mcp-proxy-token",
      getConvexHttpUrl(),
    ).toString();
  } catch (err) {
    logger.error("[harness-proxy-token] endpoint not configured", err);
    return {
      ok: false,
      status: 500,
      error: "Harness mcp-proxy-token endpoint is not configured",
    };
  }
  const bearer = args.bearer.trim();
  const authorization = /^bearer\s/i.test(bearer) ? bearer : `Bearer ${bearer}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        projectId: args.projectId,
        serverIds: args.serverIds,
        ...(args.evalScope ? { iterationId: args.evalScope.iterationId } : {}),
      }),
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (err) {
    logger.error("[harness-proxy-token] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach harness mcp-proxy-token endpoint",
    };
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: `Harness mcp-proxy-token returned ${response.status} with non-JSON body`,
    };
  }

  // `typeof null === "object"` and arrays pass a bare typeof check — require a
  // real record of string tokens so malformed payloads stay on the error path.
  const tokens = payload?.tokens;
  const tokensValid =
    !!tokens &&
    typeof tokens === "object" &&
    !Array.isArray(tokens) &&
    Object.values(tokens).every((t) => typeof t === "string");
  if (!response.ok || payload?.ok !== true || !tokensValid) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Harness mcp-proxy-token failed (${response.status})`,
    };
  }

  // Read only when the caller asked for a scope. A claimless mint has no
  // authorized run to report a decision for, and reading one from a response
  // that could not have it would invent an answer.
  const harnessEvidence = args.evalScope
    ? readHarnessEvidenceDecision(payload?.harnessEvidence)
    : undefined;

  return {
    ok: true,
    tokens: tokens as Record<string, string>,
    ...(harnessEvidence ? { harnessEvidence } : {}),
  };
}

/**
 * Parse the mint's evidence decision, or `undefined` if it did not report one.
 *
 * Strict: a malformed decision is no decision. Capture is an awaited durable
 * write in front of every tool call, so "the field was there but unreadable"
 * must never resolve to on — and grading from evidence is only ever offered
 * alongside capture.
 */
function readHarnessEvidenceDecision(
  raw: unknown,
): HarnessEvidenceDecision | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.captureEnabled !== "boolean") return undefined;
  const gradingSource =
    record.gradingSource === "evidence" ? "evidence" : "narration";
  return {
    captureEnabled: record.captureEnabled,
    gradingSource: record.captureEnabled ? gradingSource : "narration",
  };
}
