import type { ReactNode } from "react";
import { HostWorkspace } from "@/components/host-workspace/HostWorkspace";
import { StaticWidgetTranscript } from "@/components/chat-v2/thread/widget-presentation";

/** The runner supplies its existing live panel; no second renderer or RPC owner. */
export function RunHostWorkspace({
  transcript,
  appPanel,
  appOpen,
}: {
  transcript: ReactNode;
  appPanel: ReactNode;
  appOpen: boolean;
}) {
  return (
    <HostWorkspace appPanel={appPanel} appOpen={appOpen}>
      <StaticWidgetTranscript>{transcript}</StaticWidgetTranscript>
    </HostWorkspace>
  );
}
