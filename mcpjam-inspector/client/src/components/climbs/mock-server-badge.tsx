import { useState } from "react";
import { useSharedAppState } from "@/state/app-state-context";
import { findProjectByAnyId } from "@/state/app-types";
import { MockBadge } from "./mock-badge";
import { MockSheet } from "./mock-sheet";
import { useClimbsEnabled } from "./use-climbs-enabled";
import { useMockServers } from "./use-mock-servers";

/**
 * The "Mock" badge on a server's row, for a server that is a mock. It opens the
 * mock's sheet. A server that is not a mock, or a project with climbs off,
 * shows nothing and asks for nothing.
 */
export function MockServerBadge(props: { projectId?: string | null; serverName: string }) {
  // The reads below start only with the flag on, so a project without climbs pays nothing.
  return useClimbsEnabled() ? <MockBadgeForServer {...props} /> : null;
}

function MockBadgeForServer({ projectId, serverName }: { projectId?: string | null; serverName: string }) {
  const appState = useSharedAppState();
  const active = findProjectByAnyId(appState.projects, projectId ?? appState.activeProjectId);
  const convexProjectId = active?.sharedProjectId ?? projectId ?? null;
  const { mocks } = useMockServers(convexProjectId, true);
  const [open, setOpen] = useState(false);
  const mock = mocks.get(serverName);
  if (!mock || !convexProjectId) return null;
  return (
    <>
      <button
        type="button"
        aria-label="Open the mock server"
        className="rounded-full"
        onClick={(event) => {
          // The row opens the server's own page when it is clicked.
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <MockBadge />
      </button>
      <MockSheet projectId={convexProjectId} mockId={mock.id} name={serverName} open={open} onOpenChange={setOpen} />
    </>
  );
}
