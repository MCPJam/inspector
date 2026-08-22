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
  if (!url.searchParams.has("token") && !url.pathname.includes("/shared/")) {
    return;
  }
  const next = url.pathname.replace(/\/shared\/[^/]+$/, "/shared");
  window.history.replaceState({}, "", next + url.search);
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
