import { Loader2 } from "lucide-react";
import { HARNESS_STARTUP_LABELS } from "@/shared/harness-startup";
import { useHarnessStartupStore } from "@/stores/harness-startup-store";
export function HarnessStartupStatus({
  chatSessionId,
  loading,
}: {
  chatSessionId?: string | null;
  loading: boolean;
}) {
  const phase = useHarnessStartupStore(
    (state) => state.phases[chatSessionId ?? "new"],
  );
  if (!loading || !phase) return null;
  return (
    <p
      role="status"
      className="flex items-center gap-2 px-2 pb-2 text-sm text-muted-foreground"
    >
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      {HARNESS_STARTUP_LABELS[phase]}
    </p>
  );
}
