import { HostBuilderViewRedesigned } from "./redesigned/HostBuilderViewRedesigned";

interface HostBuilderViewProps {
  hostId: string;
  projectId: string;
  /**
   * Reconnects one server by name. Threaded from `App` (which owns it) so a
   * saved setting that only takes effect at connect time can be applied to the
   * live connection — see the cancellation hook in `handleSave`.
   */
  onReconnect?: (
    serverName: string,
    options?: { forceOAuthFlow?: boolean; allowInteractiveOAuthFlow?: boolean }
  ) => Promise<unknown> | void;
}

export function HostBuilderView(props: HostBuilderViewProps) {
  return <HostBuilderViewRedesigned {...props} />;
}
