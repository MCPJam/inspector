import { useAuth } from "@workos-inc/authkit-react";
import { useCallback, useEffect, useState } from "react";
import { SHARE_LINK_DENIED_MESSAGE } from "@/components/sharing/SharedArtifactPage";
import { getOrCreateGuestSession } from "@/lib/guest-session";

export type SharedResourceType = "conformanceRun" | "evalRun" | "scenario";

export type SharedArtifactState = {
  loading: boolean;
  error: string | null;
  artifact: unknown | null;
  redeem: {
    resourceType: string;
    resourceId: string;
    role: string;
    mode: string;
    projectId: string | null;
    accessVersion: number;
  } | null;
};

async function bearerForViewer(
  getAccessToken: (() => Promise<string | undefined>) | undefined,
): Promise<string | null> {
  if (getAccessToken) {
    const token = await getAccessToken().catch(() => undefined);
    if (token) return token;
  }
  const guest = await getOrCreateGuestSession();
  return guest?.token ?? null;
}

function stripTokenFromUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const hasQueryToken = url.searchParams.has("token");
  if (!hasQueryToken && !url.pathname.includes("/shared/")) {
    return;
  }
  // The query form has to be dropped explicitly: re-appending `url.search`
  // would otherwise carry the credential straight back into the address bar.
  if (hasQueryToken) {
    url.searchParams.delete("token");
  }
  const next = url.pathname.replace(/\/shared\/[^/]+$/, "/shared");
  window.history.replaceState({}, "", next + url.search);
}

/**
 * Read a pre-shareable-layer conformance share link. The legacy endpoint is
 * unauthenticated by design (the HMAC token IS the credential) and returns
 * the same redacted public artifact. Deleted with the HMAC scheme at I6/B6.
 */
async function loadLegacyConformanceArtifact(
  token: string,
): Promise<unknown | null> {
  try {
    const res = await fetch(
      `/api/web/conformance-shared/${encodeURIComponent(token)}`,
      { credentials: "include" },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      artifact?: unknown;
    } | null;
    return body?.artifact ?? null;
  } catch {
    return null;
  }
}

export function useSharedArtifact({
  resourceType,
  token,
}: {
  resourceType: SharedResourceType;
  token: string | undefined;
}): SharedArtifactState {
  const { getAccessToken, user } = useAuth();
  const [state, setState] = useState<SharedArtifactState>({
    loading: true,
    error: null,
    artifact: null,
    redeem: null,
  });

  const load = useCallback(async () => {
    if (!token) {
      setState({
        loading: false,
        error: SHARE_LINK_DENIED_MESSAGE,
        artifact: null,
        redeem: null,
      });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const bearer = await bearerForViewer(getAccessToken);
      if (!bearer) {
        throw new Error("unauthenticated");
      }
      const redeemRes = await fetch("/api/web/shared/redeem", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ resourceType, token }),
      });
      const redeemBody = (await redeemRes.json().catch(() => null)) as {
        ok?: boolean;
        resourceType?: string;
        resourceId?: string;
        role?: string;
        mode?: string;
        projectId?: string | null;
        accessVersion?: number;
      } | null;
      if (!redeemRes.ok || !redeemBody?.ok || !redeemBody.resourceId) {
        throw new Error("denied");
      }
      const artifactRes = await fetch(
        `/api/web/shared/${encodeURIComponent(redeemBody.resourceType ?? resourceType)}/${encodeURIComponent(redeemBody.resourceId)}/artifact`,
        {
          credentials: "include",
          headers: { authorization: `Bearer ${bearer}` },
        },
      );
      if (!artifactRes.ok) {
        throw new Error("denied");
      }
      const artifact = await artifactRes.json().catch(() => null);
      stripTokenFromUrl();

      setState({
        loading: false,
        error: null,
        artifact,
        redeem: {
          resourceType: redeemBody.resourceType ?? resourceType,
          resourceId: redeemBody.resourceId,
          role: redeemBody.role ?? "viewer",
          mode: redeemBody.mode ?? "anyone_with_link",
          projectId: redeemBody.projectId ?? null,
          accessVersion: redeemBody.accessVersion ?? 0,
        },
      });
    } catch {
      // MIXED-VERSION FALLBACK, REMOVED AT I6/B6.
      //
      // Conformance links minted before the shareable layer are stateless
      // HMAC tokens: they were never registered in `shareResources`, so the
      // redeem above can never find them. Without this, deploying the new
      // viewer would kill every conformance share link already in the wild —
      // and, while the management flag is off, the legacy toggle keeps
      // minting exactly those links, so sharing would mint dead links.
      if (resourceType === "conformanceRun") {
        const legacy = await loadLegacyConformanceArtifact(token);
        if (legacy) {
          stripTokenFromUrl();
          setState({
            loading: false,
            error: null,
            artifact: legacy,
            redeem: null,
          });
          return;
        }
      }
      stripTokenFromUrl();
      setState({
        loading: false,
        error: SHARE_LINK_DENIED_MESSAGE,
        artifact: null,
        redeem: null,
      });
    }
  }, [getAccessToken, resourceType, token, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return state;
}
