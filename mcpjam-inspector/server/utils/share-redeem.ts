/**
 * Generic share-link redeem. Forwards bearer to Convex POST /web/share/redeem.
 */

import { logger } from "./logger.js";

export type ShareRedeemSuccess = {
  ok: true;
  resourceType: string;
  resourceId: string;
  role: string;
  mode: string;
  projectId: string | null;
  accessVersion: number;
  payload: unknown;
};

export type ShareRedeemFailure = {
  ok: false;
  status: number;
  error: string;
};

export type ShareRedeemResult = ShareRedeemSuccess | ShareRedeemFailure;

function convexHttpUrl(): string {
  const url = process.env.CONVEX_HTTP_URL;
  if (!url) {
    throw new Error("CONVEX_HTTP_URL is required for share redeem");
  }
  return url;
}

export async function redeemShareToken(args: {
  resourceType: string;
  token: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<ShareRedeemResult> {
  const authorization = args.bearer.startsWith("Bearer ")
    ? args.bearer
    : `Bearer ${args.bearer}`;
  const url = new URL("/web/share/redeem", convexHttpUrl()).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify({
        resourceType: args.resourceType,
        token: args.token,
      }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[share-redeem] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach share redeem endpoint",
    };
  }

  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    resourceType?: string;
    resourceId?: string;
    role?: string;
    mode?: string;
    projectId?: string | null;
    accessVersion?: number;
    payload?: unknown;
  } | null;

  if (!response.ok || !payload?.ok || !payload.resourceId) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : "This share link is invalid or has been revoked.",
    };
  }

  return {
    ok: true,
    resourceType: payload.resourceType ?? args.resourceType,
    resourceId: payload.resourceId,
    role: payload.role ?? "viewer",
    mode: payload.mode ?? "anyone_with_link",
    projectId: payload.projectId ?? null,
    accessVersion: payload.accessVersion ?? 0,
    payload: payload.payload ?? null,
  };
}

export async function fetchShareArtifact(args: {
  resourceType: string;
  resourceId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; body: unknown } | ShareRedeemFailure> {
  const authorization = args.bearer.startsWith("Bearer ")
    ? args.bearer
    : `Bearer ${args.bearer}`;
  const url = new URL("/web/share/artifact", convexHttpUrl());
  url.searchParams.set("type", args.resourceType);
  url.searchParams.set("id", args.resourceId);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { authorization },
      signal: args.signal,
      redirect: "manual",
    });
  } catch (err) {
    logger.error("[share-artifact] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to load shared artifact",
    };
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, status: 502, error: "Shared artifact lookup redirected" };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status === 403 ? 403 : response.status === 404 ? 404 : 502,
      error: "This share link is invalid or has been revoked.",
    };
  }
  return { ok: true, body };
}
