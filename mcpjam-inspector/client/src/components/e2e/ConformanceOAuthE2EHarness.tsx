import { useMemo } from "react";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useConformanceRun } from "@/hooks/use-conformance-run";
import type { ConformanceSelection } from "@/shared/conformance-settings";

const OAUTH_ONLY: ConformanceSelection = {
  protocol: [],
  apps: [],
  tasks: [],
  oauth: true,
};

/**
 * DEV-only surface for the conformance OAuth popup: the real run hook and
 * callback page, with the conformance API answered by the test.
 */
export function ConformanceOAuthE2EHarness() {
  const serverUrl =
    new URLSearchParams(window.location.search).get("serverUrl") ?? "";
  const server = useMemo<ServerWithName>(
    () => ({
      name: "conformance-e2e-target",
      config: { url: serverUrl },
      connectionStatus: "connected",
      enabled: true,
      retryCount: 0,
      useOAuth: true,
      lastConnectionTime: new Date(0),
    }),
    [serverUrl],
  );
  const run = useConformanceRun({ server, selection: OAUTH_ONLY });

  return (
    <div className="flex flex-col gap-3 p-4">
      <button
        type="button"
        className="h-8 w-fit rounded-md border border-border px-3"
        onClick={() => void run.runAll()}
      >
        Run checks
      </button>
      <span data-testid="conformance-oauth-status">{run.oauth.status}</span>
      <span data-testid="conformance-oauth-error">{run.oauth.error}</span>
    </div>
  );
}
