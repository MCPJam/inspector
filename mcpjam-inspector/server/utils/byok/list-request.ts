import {
  DEFAULT_LIST_TIMEOUT_MS,
  type ByokAdapterDeps,
  type ByokListResult,
} from "./types.js";

type ListFailure = Extract<ByokListResult, { ok: false }>;

export type JsonFetchResult =
  { ok: true; body: unknown } | { ok: false; failure: ListFailure };

/**
 * GET a provider list endpoint and parse its JSON body.
 *
 * Failure messages name the provider, the endpoint path and the HTTP status,
 * nothing else. The upstream body is never read on a non-2xx answer: OpenAI's
 * 401 body, for one, echoes a masked copy of the key it was sent. `url` must
 * not carry a key (every adapter sends it in a header), so the message cannot
 * leak one through the URL either.
 */
export async function getProviderJson(
  providerLabel: string,
  url: string,
  endpointLabel: string,
  headers: Record<string, string>,
  deps: ByokAdapterDeps = {},
): Promise<JsonFetchResult> {
  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "network_error",
        message: `${providerLabel} ${endpointLabel} could not be reached`,
      },
    };
  }

  if (!response.ok) {
    const unauthorized = response.status === 401 || response.status === 403;
    return {
      ok: false,
      failure: {
        ok: false,
        code: unauthorized ? "unauthorized" : "http_error",
        status: response.status,
        message: unauthorized
          ? `${providerLabel} ${endpointLabel} refused the key (${response.status})`
          : `${providerLabel} ${endpointLabel} answered ${response.status}`,
      },
    };
  }

  try {
    return { ok: true, body: await response.json() };
  } catch {
    return {
      ok: false,
      failure: malformed(providerLabel, endpointLabel),
    };
  }
}

export function malformed(
  providerLabel: string,
  endpointLabel: string,
): ListFailure {
  return {
    ok: false,
    code: "malformed_response",
    message: `${providerLabel} ${endpointLabel} returned an unexpected body`,
  };
}

export function missingCredentials(providerLabel: string): ListFailure {
  return {
    ok: false,
    code: "missing_credentials",
    message: `${providerLabel} needs an API key to list models`,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readPositiveInt(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** Trimmed, de-duplicated, non-empty ids in first-seen order. */
export function normalizeIds(ids: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids ?? []) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function trimTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
