import type { HostAttentionIssue } from "../types";
import { FocusBlock } from "./primitives";

interface GeneralTabProps {
  attention: ReadonlyArray<HostAttentionIssue>;
}

// Name + style now live in the sticky identity header. This tab is the
// home for host-wide settings that don't belong to a negotiation surface
// (description, danger zone, etc.). Placeholder block until those land.
export function GeneralTab(_: GeneralTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <FocusBlock title="General" subtitle="Client-wide settings.">
        <p className="text-[11.5px] text-muted-foreground">
          Nothing here yet — client name and style live in the header above.
        </p>
      </FocusBlock>
    </div>
  );
}
