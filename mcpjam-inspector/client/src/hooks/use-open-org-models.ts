import { useCallback, useMemo } from "react";
import { useSharedAppState } from "@/state/app-state-context";

/**
 * Returns a callback that navigates the user to the active organization's
 * model-provider settings page (Org → Models). Used by BYOK error surfaces
 * (banners + toasts) to wire up the "Open Organization Models" CTA without
 * threading `onNavigate` through every component.
 *
 * Returns `undefined` for `openOrgModels` when there is no active
 * organization (e.g. guest surfaces, unauthenticated local mode) so callers
 * can skip rendering the CTA entirely.
 *
 * Uses hash-based routing to match the rest of the app (see App.tsx).
 *
 * Tests that render a component using this hook must either:
 *   - wrap in `<AppStateProvider>` (production setup), OR
 *   - `vi.mock("@/state/app-state-context")` exposing `useSharedAppState`, OR
 *   - `vi.mock("@/hooks/use-open-org-models")` to stub the hook directly.
 */
export function useOpenOrgModels(): {
  activeOrganizationId: string | undefined;
  openOrgModels: (() => void) | undefined;
} {
  const appState = useSharedAppState();
  const activeOrganizationId = useMemo(() => {
    const project = appState.projects[appState.activeProjectId];
    return project?.organizationId ?? undefined;
  }, [appState.projects, appState.activeProjectId]);

  const openOrgModels = useCallback(() => {
    if (!activeOrganizationId) return;
    if (typeof window === "undefined") return;
    window.location.hash = `organizations/${activeOrganizationId}/models`;
  }, [activeOrganizationId]);

  return {
    activeOrganizationId,
    openOrgModels: activeOrganizationId ? openOrgModels : undefined,
  };
}
