import { useEffect, useLayoutEffect } from "react";
import { useStore } from "zustand";
import {
  projectTransitionRecovery,
  PROJECT_TRANSITION_TTL_MS,
} from "@/lib/auth/project-transition-recovery";
import { useAppNavigate, useCurrentLocationParts } from "@/lib/app-navigation";
import { resolveProjectSignInReturnRecovery } from "@/lib/project-route-recovery";

/** Only a proven pre-sign-in route can recover from an unavailable project. */
export function useProjectTransitionRecovery(args: {
  actor: string | null;
  ready: boolean;
  routeReady: boolean;
  membershipProjectIds: ReadonlySet<string> | undefined;
  fallbackProjectId: string | null;
}) {
  const location = useCurrentLocationParts();
  const path = location.pathname + location.search + location.hash;
  const navigate = useAppNavigate();
  const marker = useStore(projectTransitionRecovery.store, (s) => s.marker);
  useEffect(() => {
    if (!marker) return;
    const timer = setTimeout(
      () => projectTransitionRecovery.clear(marker.attempt),
      Math.max(0, marker.storedAt + PROJECT_TRANSITION_TTL_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [marker]);
  const matches =
    marker && projectTransitionRecovery.isValid(marker) && marker.path === path;
  const decision = resolveProjectSignInReturnRecovery({
    intent: matches ? { ...marker, fallback: "home" } : null,
    membershipProjectIds:
      args.ready && args.actor && args.actor !== marker?.sourceActor
        ? args.membershipProjectIds
        : undefined,
    fallbackProjectId: args.fallbackProjectId,
  });
  useEffect(() => {
    if (projectTransitionRecovery.store.getState().marker !== marker) return;
    // Callback owns the marker until it has selected the winning return flow.
    if (location.pathname === "/callback") return;
    if (marker && !matches) projectTransitionRecovery.clear(marker.attempt);
    if (decision.kind !== "none" && decision.kind !== "wait" && marker) {
      projectTransitionRecovery.clear(marker.attempt);
      if (decision.kind === "home")
        navigate("/", { replace: true, unscoped: true });
      else if (decision.kind === "switch")
        navigate(decision.path, { replace: true });
    }
  }, [
    path,
    marker,
    matches,
    decision.kind,
    args.ready,
    args.membershipProjectIds,
    args.fallbackProjectId,
    navigate,
  ]);
  useLayoutEffect(() => {
    if (!args.actor) return;
    projectTransitionRecovery.observeActor(args.actor, path);
    if (
      args.ready &&
      args.routeReady &&
      !projectTransitionRecovery.store.getState().marker
    ) {
      projectTransitionRecovery.remember(path, args.actor);
    }
  }, [path, args.actor, args.ready, args.routeReady]);
  return !!matches && decision.kind !== "open";
}
