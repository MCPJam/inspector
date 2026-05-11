import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppReadyProvider, useAppReady } from "@/hooks/use-app-ready";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

function renderAppReady(props: {
  isLoadingAppState?: boolean;
  isConvexAuthLoading?: boolean;
  isConvexAuthenticated?: boolean;
  effectiveActiveProjectId?: string;
  isLoadingRemoteProjects?: boolean;
}) {
  return renderHook(() => useAppReady(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AppReadyProvider
        isLoadingAppState={props.isLoadingAppState ?? false}
        isConvexAuthLoading={props.isConvexAuthLoading ?? false}
        isConvexAuthenticated={props.isConvexAuthenticated ?? false}
        effectiveActiveProjectId={props.effectiveActiveProjectId ?? "local"}
        isLoadingRemoteProjects={props.isLoadingRemoteProjects ?? false}
      >
        {children}
      </AppReadyProvider>
    ),
  });
}

describe("AppReadyProvider", () => {
  it("keeps non-hosted local mode ready without Convex auth or remote projects", () => {
    const { result } = renderAppReady({
      isConvexAuthenticated: false,
      effectiveActiveProjectId: "local-project",
      isLoadingRemoteProjects: false,
    });

    expect(result.current).toEqual({
      status: "ready",
      projectId: "local-project",
    });
  });
});
