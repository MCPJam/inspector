import { authFetch } from "@/lib/session-token";
import { WebApiError } from "@/lib/apis/web/base";
import { getConvexSiteUrl } from "@/lib/convex-site-url";
import type { RegistryServer } from "@/lib/registry-server-types";

export interface RegistryCatalogCard {
  registryCardKey: string;
  catalogSortOrder: number;
  variants: RegistryServer[];
  starCount: number;
  isStarred: boolean;
}

export interface RegistryStarMutationResult {
  isStarred: boolean;
  starCount: number;
}

function getRegistryHttpBaseUrl(): string {
  const site = getConvexSiteUrl();
  if (!site) {
    throw new WebApiError(
      0,
      "NO_CONVEX_SITE",
      "Convex site URL is not configured (VITE_CONVEX_URL or VITE_CONVEX_SITE_URL)",
    );
  }
  return site.replace(/\/$/, "");
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function throwFromFailedResponse(response: Response, body: unknown): never {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const code =
    typeof record?.code === "string"
      ? record.code
      : typeof record?.error === "string"
        ? record.error
        : null;
  const message =
    typeof record?.message === "string"
      ? record.message
      : typeof record?.error === "string"
        ? record.error
        : `Request failed (${response.status})`;
  throw new WebApiError(response.status, code, message);
}

export function extractCatalogCards(data: unknown): RegistryCatalogCard[] {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.cards)) return obj.cards as RegistryCatalogCard[];
  if (Array.isArray(obj.catalog)) return obj.catalog as RegistryCatalogCard[];
  if (Array.isArray(data)) return data as RegistryCatalogCard[];
  return [];
}

export async function fetchRegistryCatalog(
  category?: string | null,
): Promise<RegistryCatalogCard[]> {
  const base = getRegistryHttpBaseUrl();
  const response = await authFetch(`${base}/web/registry/catalog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      category === undefined || category === null ? {} : { category },
    ),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    throwFromFailedResponse(response, body);
  }
  return extractCatalogCards(body);
}

export async function starRegistryCard(
  registryCardKey: string,
): Promise<RegistryStarMutationResult> {
  const base = getRegistryHttpBaseUrl();
  const response = await authFetch(`${base}/web/registry/star`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registryCardKey }),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    throwFromFailedResponse(response, body);
  }
  return normalizeStarResult(body);
}

export async function unstarRegistryCard(
  registryCardKey: string,
): Promise<RegistryStarMutationResult> {
  const base = getRegistryHttpBaseUrl();
  const response = await authFetch(`${base}/web/registry/unstar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registryCardKey }),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    throwFromFailedResponse(response, body);
  }
  return normalizeStarResult(body);
}

function normalizeStarResult(body: unknown): RegistryStarMutationResult {
  if (!body || typeof body !== "object") {
    return { isStarred: false, starCount: 0 };
  }
  const o = body as Record<string, unknown>;
  return {
    isStarred: Boolean(o.isStarred),
    starCount:
      typeof o.starCount === "number" && Number.isFinite(o.starCount)
        ? Math.max(0, Math.floor(o.starCount))
        : 0,
  };
}

export async function mergeGuestRegistryStars(
  guestToken: string,
): Promise<unknown> {
  const base = getRegistryHttpBaseUrl();
  const response = await authFetch(`${base}/web/registry/merge-guest-stars`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guestToken }),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    throwFromFailedResponse(response, body);
  }
  return body;
}
